/**
 * Live SGLang on a real Linux host (change `add-sglang-runtime`, task 2.5; specs `sglang-runtime`,
 * `managed-model-store`; design D3, D4, D5). The rest of the suite proves the provider against a fake
 * Docker and a fake engine; this file is the only proof that a real `sglang.launch_server` container
 * from the pinned `lmsysorg/sglang` image installs on the prepared environment, loads the curated
 * `Qwen/Qwen3.5-2B` from the managed model store with core's static memory share and text only,
 * streams through the public server, answers with thinking off in `content` and with thinking on in
 * `reasoning_content`, calls a tool through its parser, refuses a request over its context with
 * `context_length_exceeded`, runs Hugging Face offline with no remote code, no request log and no
 * connection out of the container, and starts faster the second time from its compile cache.
 *
 * It writes what task 4.1 carries into the change's rulings: `<out>/summary.json` (load and reload
 * times, the memory share the core passed, the card's free memory before the load, SGLang's own
 * memory readings — free before the weights, after them, after the KV pool, before graph capture — and
 * its KV pool in tokens, the container's `/dev/shm` use) and `<out>/sglang-start.log`, the engine's own
 * log of the first start, which replaces the constructed lines of `test/helpers/sglang-log-fixtures.ts`.
 *
 * It drives the compiled core only (no `src/` imports). It installs the SGLang engine if it is not
 * `ready` yet, but only on an environment that needs no privileged step (Docker with the NVIDIA runtime
 * already there — the TensorRT-LLM install test, vLLM, or the app prepared it); otherwise it stops and
 * says so.
 *
 * Runs only with ATOMIC_LIVE=1 on Linux with `/usr/bin/nvidia-smi`; anywhere else every live scenario
 * is skipped with that reason. Optional: ATOMIC_LIVE_CORE_BIN, ATOMIC_RUNTIME_DESCRIPTOR_URL_SGLANG
 * (default: the conf fixture copy in this repo) and ATOMIC_ENVIRONMENT_MANIFEST_URL,
 * ATOMIC_LIVE_MANAGED_ROOT, ATOMIC_LIVE_OUT, ATOMIC_LIVE_MODEL_CACHE, ATOMIC_LIVE_GPU (a card's UUID;
 * default the core's choice), HF_ENDPOINT, HF_TOKEN. The core runs with DO_NOT_TRACK=1: a test run
 * sends no error reports.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { httpRequest, pollOperation, startLiveCore, streamChat, THINKING_OFF } from '../helpers/live-core.js'
import type { LiveCore, OperationView } from '../helpers/live-core.js'
import {
  containerRemotePeers,
  inspectContainer,
  ownContainers,
  remoteTcpPeers,
  shmUsedBytes,
} from '../helpers/live-engine.js'
import { prepareCuratedModel, readDescriptor } from '../helpers/live-hf-model.js'
import type { CuratedModel, PreparedModel } from '../helpers/live-hf-model.js'
import type { GpuFacts } from '../../src/contracts/index.js'

const NVIDIA_SMI = '/usr/bin/nvidia-smi'
const ENABLED = process.env['ATOMIC_LIVE'] === '1' && process.platform === 'linux' && existsSync(NVIDIA_SMI)
const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const CPU = process.arch === 'arm64' ? 'aarch64' : 'x86_64'
const BIN =
  process.env['ATOMIC_LIVE_CORE_BIN'] ?? join(ROOT, 'dist/bin', `atomic-chat-core-${CPU}-unknown-linux-gnu`)
const DESCRIPTOR_URL =
  process.env['ATOMIC_RUNTIME_DESCRIPTOR_URL_SGLANG'] ??
  pathToFileURL(join(ROOT, 'test/fixtures/runtimes/sglang.json')).href
const MANIFEST_URL =
  process.env['ATOMIC_ENVIRONMENT_MANIFEST_URL'] ??
  pathToFileURL(join(ROOT, 'test/fixtures/runtimes/environments/linux.json')).href
const MODEL_CACHE =
  process.env['ATOMIC_LIVE_MODEL_CACHE'] ?? join(homedir(), '.cache', 'atomic-chat-live', 'hf')
const GPU = process.env['ATOMIC_LIVE_GPU']
const MODEL = 'Qwen/Qwen3.5-2B'
const MIN = 60_000
const HOUR = 60 * MIN
const TARGET = { kind: 'runtime', installation_id: 'sglang', engine_id: 'sglang' }

interface Descriptor {
  descriptor_id: string
  curated_models: CuratedModel[]
}
interface Session {
  port: number
  api_key: string | null
  generation?: string
}
interface ChatAnswer {
  choices?: {
    message?: { content?: string | null; reasoning_content?: string | null; tool_calls?: unknown[] }
  }[]
  error?: { code?: string; message?: string }
}

const S: {
  core: LiveCore | null
  dataFolder: string
  out: string
  descriptor: Descriptor | null
  model: PreparedModel | null
  publicPort: number
  summary: Record<string, unknown>
} = { core: null, dataFolder: '', out: '', descriptor: null, model: null, publicPort: 0, summary: {} }

const core = (): LiveCore => {
  if (S.core === null) throw new Error('the core did not start; see core.log')
  return S.core
}
const log = (line: string): void => {
  console.log(`[live sglang] ${line}`)
}

async function load(): Promise<{ session: Session; ms: number }> {
  const started = Date.now()
  const answer = await core().api.post<{ session: Session }>(
    `/models/sglang/${S.model?.id}/load`,
    {},
    2 * HOUR
  )
  if (answer.status !== 200) throw new Error(`load answered ${answer.status}: ${answer.text}`)
  return { session: answer.body.session, ms: Date.now() - started }
}

async function chat(body: Record<string, unknown>): Promise<{ status: number; body: ChatAnswer }> {
  const answer = await httpRequest({
    url: `http://127.0.0.1:${S.publicPort}/v1/chat/completions`,
    method: 'POST',
    body: JSON.stringify({ model: S.model?.id, max_tokens: 256, ...body }),
    timeoutMs: 10 * MIN,
  })
  return { status: answer.status, body: JSON.parse(answer.text || '{}') as ChatAnswer }
}

/** The one container of this core's SGLang session. */
function ourContainerId(): string {
  const ids = ownContainers(core().ready.instance_id, false, 'sglang')
  expect(ids.length, 'one model container of this core').toBe(1)
  return ids[0] as string
}

/** SGLang's own memory readings in its start log (`model_runner.py`, `kv_cache_configurator.py`, …). */
function sglangMemoryReadings(startLog: string): Record<string, number | null> {
  const number = (pattern: RegExp) => {
    const match = pattern.exec(startLog)
    return match === null ? null : Number(match[1])
  }
  return {
    sglang_free_gb_before_weights: number(/Load weight begin\. avail mem=([\d.]+) GB/),
    sglang_free_gb_after_weights: number(/Load weight end\..*?avail mem=([\d.]+) GB/),
    sglang_weights_gb: number(/Load weight end\..*?mem usage=([\d.]+) GB/),
    sglang_free_gb_after_kv_pool: number(/Memory pool end\. avail mem=([\d.]+) GB/),
    sglang_free_gb_before_graphs: number(/Capture .*? begin\..*?avail mem=([\d.]+) GB/),
    sglang_max_total_num_tokens: number(/max_total_num_tokens=(\d+)/),
    sglang_free_gb_when_ready: number(/available_gpu_mem=([\d.]+) GB/),
  }
}

describe('remoteTcpPeers (the network check of the live run)', () => {
  it('keeps established and connecting sockets to other hosts, drops loopback and listeners', () => {
    const tcp = [
      '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      '   0: 00000000:7530 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1 1',
      '   1: 0100007F:7530 0100007F:9C40 01 00000000:00000000 00:00000000 00000000  1000        0 2 1',
      '   2: 0200000A:A1B2 08080808:01BB 02 00000000:00000000 00:00000000 00000000  1000        0 3 1',
    ].join('\n')
    const tcp6 = [
      '  sl  local_address                         remote_address                        st',
      '   0: 00000000000000000000000001000000:7530 00000000000000000000000001000000:9C40 01',
      '   1: 0000000000000000FFFF00000100007F:7530 0000000000000000FFFF00000100007F:9C41 01',
      '   2: 00000000000000000000000001000000:7530 B80D0120000000000000000001000000:01BB 01',
    ].join('\n')
    expect(remoteTcpPeers(`${tcp}\n${tcp6}`)).toEqual([
      { address: '8.8.8.8', port: 443, state: 'SYN_SENT' },
      { address: '2001:db8:0:0:0:0:0:1', port: 443, state: 'ESTABLISHED' },
    ])
  })
})

describe.skipIf(!ENABLED)('live SGLang (ATOMIC_LIVE=1)', () => {
  beforeAll(async () => {
    const name = new Date().toISOString().replace(/[:.]/g, '-')
    S.out = process.env['ATOMIC_LIVE_OUT'] ?? join(ROOT, 'test/tmp/live-sglang', name)
    S.dataFolder = join(S.out, 'data')
    mkdirSync(S.dataFolder, { recursive: true })
    S.descriptor = await readDescriptor<Descriptor>(DESCRIPTOR_URL, 'SGLang descriptor')
    S.core = await startLiveCore({
      label: 'sglang',
      bin: BIN,
      dataFolder: S.dataFolder,
      env: {
        ATOMIC_RUNTIME_DESCRIPTOR_URL_SGLANG: DESCRIPTOR_URL,
        ATOMIC_ENVIRONMENT_MANIFEST_URL: MANIFEST_URL,
        DO_NOT_TRACK: '1',
        ...(process.env['ATOMIC_LIVE_MANAGED_ROOT'] === undefined
          ? {}
          : { ATOMIC_CORE_MANAGED_ROOT: process.env['ATOMIC_LIVE_MANAGED_ROOT'] }),
      },
      logFile: join(S.out, 'core.log'),
    })
    if (GPU !== undefined) await core().api.patch('/settings/sglang', { values: { gpu_id: GPU } })
  }, 5 * MIN)

  afterAll(async () => {
    writeFileSync(join(S.out, 'summary.json'), `${JSON.stringify(S.summary, null, 2)}\n`)
    if (S.model !== null)
      await core()
        .api.post(`/models/sglang/${S.model.id}/unload`, {}, 10 * MIN)
        .catch(() => null)
    await S.core?.stop()
  }, 15 * MIN)

  it(
    'setup: SGLang installs on the prepared environment with no privileged step (or is ready already)',
    async () => {
      const snapshot = await core().api.get<{
        environments: { installations: { engine_id: string; status: string }[] }[]
      }>('/snapshot')
      const installed = snapshot.body.environments[0]?.installations.find((i) => i.engine_id === 'sglang')
      if (installed?.status === 'ready') {
        log('SGLang is installed already')
        return
      }
      const started = Date.now()
      const begun = await core().api.post<OperationView>('/environments/default/operations', {
        request_id: `live-sglang-${Date.now()}`,
        target: TARGET,
        kind: 'setup',
        descriptor_id: S.descriptor?.descriptor_id,
      })
      expect(begun.status, begun.text).toBe(200)
      const asking = await pollOperation(
        core().api,
        begun.body.operation_id,
        (o) => o.phase !== 'checking',
        10 * MIN
      )
      expect(
        asking.pending_host_step,
        'the environment must already be prepared (run the install test first)'
      ).toBeNull()
      expect(asking.phase, JSON.stringify(asking.error)).toBe('awaiting-consent')
      await core().api.post(`/environments/operations/${asking.operation_id}/resume`, {
        expected_revision: asking.revision,
        approved_plan_digest: asking.plan_digest,
      })
      const done = await pollOperation(
        core().api,
        asking.operation_id,
        (o) => o.phase === 'ready' || o.phase === 'failed',
        2 * HOUR
      )
      expect(done.phase, JSON.stringify(done.error)).toBe('ready')
      S.summary['setup_ms'] = Date.now() - started
    },
    3 * HOUR
  )

  it(
    'load: the curated Qwen3.5-2B from the store, text only, with core’s static memory share',
    async () => {
      const curated = S.descriptor?.curated_models.find((model) => model.repository === MODEL)
      expect(curated, `${MODEL} is curated in the SGLang descriptor`).toBeDefined()
      S.model = await prepareCuratedModel({
        api: core().api,
        model: curated as CuratedModel,
        gpuId: GPU,
        dataFolder: S.dataFolder,
        cacheRoot: MODEL_CACHE,
        log,
        provider: 'sglang',
      })
      // Free on the card as core last probed it, before the container: with SGLang's own reading before
      // its weights (below) it shows what SGLang's CUDA context takes on this host (design D4).
      const environments = await core().api.get<{ environments: { gpus: GpuFacts[] }[] }>('/environments')
      const card = environments.body.environments[0]?.gpus.find((gpu) => gpu.gpu_id === GPU)
      S.summary['gpu_total_bytes'] = card?.total_vram_bytes ?? null
      S.summary['gpu_free_bytes_before_load'] = card?.free_vram_bytes ?? null
      const first = await load()
      S.summary['first_load_ms'] = first.ms
      const server = await core().api.post<{ port: number }>('/server/start', { port: 0 })
      expect(server.status, server.text).toBe(200)
      S.publicPort = server.body.port
    },
    2 * HOUR
  )

  it(
    'Окружение и аргументы контейнера: Hugging Face offline, no remote code, no request log, a read-only model, isolation flags',
    async () => {
      const id = ourContainerId()
      const facts = await inspectContainer(id)
      expect(facts).not.toBeNull()
      if (facts === null) return
      expect(facts.env).toMatchObject({ HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', DO_NOT_TRACK: '1' })
      expect(facts.env['SGLANG_CACHE_DIR']).toMatch(/^\/atomic\/engine-cache\//)
      for (const forbidden of [
        '--trust-remote-code',
        '--log-requests',
        '--api-key',
        '--admin-api-key',
        '--enable-metrics',
      ]) {
        expect(facts.command).not.toContain(forbidden)
      }
      // Qwen3.5's checkpoint has a vision tower: SGLang runs it as a language model only.
      expect(facts.command.join(' ')).toContain('{"language_model_only":true}')
      expect(facts.mounts.find((m) => m.destination === '/atomic/model')).toMatchObject({ rw: false })
      expect(facts.mounts.find((m) => m.destination === '/atomic/engine-cache')).toMatchObject({ rw: true })
      expect(facts.mounts.some((m) => m.source.endsWith('docker.sock'))).toBe(false)
      expect(facts.privileged).toBe(false)
      expect(facts.ipc_mode).not.toBe('host')
      expect(facts.restart_policy).toBe('no')
      expect(facts.published_host_ips.every((ip) => ip === '127.0.0.1')).toBe(true)
      const flag = (name: string) => facts.command[facts.command.indexOf(name) + 1]
      S.summary['mem_fraction_static'] = Number(flag('--mem-fraction-static'))
      S.summary['max_total_tokens_passed'] = facts.command.includes('--max-total-tokens')
      S.summary['cuda_graph_args'] = facts.command.filter((arg) => arg.includes('cuda-graph'))
      S.summary['shm_size_bytes'] = facts.shm_size_bytes
      S.summary['shm_used_bytes'] = await shmUsedBytes(id)
      // The engine's own first-start log, for test/helpers/sglang-log-fixtures.ts (task 4.1).
      const logs = await core().api.get<{ log_tail: string }>(`/models/sglang/${S.model?.id}/logs`)
      writeFileSync(join(S.out, 'sglang-start.log'), logs.body.log_tail)
      Object.assign(S.summary, sglangMemoryReadings(logs.body.log_tail))
    },
    5 * MIN
  )

  it(
    'chat and stream through :1337',
    async () => {
      const plain = await chat({ messages: [{ role: 'user', content: 'Say hello in one word.' }] })
      expect(plain.status).toBe(200)
      expect(plain.body.choices?.[0]?.message?.content ?? '').not.toBe('')
      const streamed = await streamChat({
        url: `http://127.0.0.1:${S.publicPort}/v1/chat/completions`,
        body: {
          model: S.model?.id,
          stream: true,
          max_tokens: 64,
          messages: [{ role: 'user', content: 'Count to three.' }],
        },
        timeoutMs: 10 * MIN,
      })
      expect(streamed.status).toBe(200)
      expect(streamed.content).not.toBe('')
      S.summary['stream_first_token_ms'] = streamed.first_token_ms
    },
    30 * MIN
  )

  it(
    'Qwen3.5 без размышлений: the answer is in content, reasoning empty — whole and streamed, unasked and turned off',
    async () => {
      for (const extra of [{}, THINKING_OFF]) {
        const plain = await chat({
          ...extra,
          messages: [{ role: 'user', content: 'What is 2 + 2? Answer with a number.' }],
        })
        expect(plain.body.choices?.[0]?.message?.content ?? '').toMatch(/4/)
        expect(plain.body.choices?.[0]?.message?.reasoning_content ?? '').toBe('')
        const streamed = await streamChat({
          url: `http://127.0.0.1:${S.publicPort}/v1/chat/completions`,
          body: {
            model: S.model?.id,
            stream: true,
            max_tokens: 64,
            ...extra,
            messages: [{ role: 'user', content: 'What is 2 + 2?' }],
          },
          timeoutMs: 10 * MIN,
        })
        expect(streamed.content).toMatch(/4/)
        expect(streamed.reasoning).toBe('')
      }
    },
    30 * MIN
  )

  it(
    'Qwen3.5 с размышлениями: thinking in reasoning_content, the answer in content',
    async () => {
      const thinking = await chat({
        max_tokens: 2048,
        chat_template_kwargs: { enable_thinking: true },
        messages: [{ role: 'user', content: 'What is 17 × 3? Answer with a number.' }],
      })
      expect(thinking.status).toBe(200)
      expect(thinking.body.choices?.[0]?.message?.reasoning_content ?? '').not.toBe('')
      expect(thinking.body.choices?.[0]?.message?.content ?? '').toMatch(/51/)
    },
    30 * MIN
  )

  it(
    'a tool call through the family’s parser',
    async () => {
      const answer = await chat({
        messages: [{ role: 'user', content: 'What is the weather in Paris? Use the tool.' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'get_weather',
              description: 'The weather in a city',
              parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
            },
          },
        ],
        tool_choice: 'auto',
      })
      expect(answer.status).toBe(200)
      expect(answer.body.choices?.[0]?.message?.tool_calls?.length ?? 0).toBeGreaterThan(0)
    },
    30 * MIN
  )

  it(
    'Длинная переписка: over the context is context_length_exceeded, and the session stays',
    async () => {
      const answer = await chat({ messages: [{ role: 'user', content: 'word '.repeat(20_000) }] })
      expect(answer.status).toBe(400)
      expect(answer.body.error?.code).toBe('context_length_exceeded')
      expect((await chat({ messages: [{ role: 'user', content: 'hi' }] })).status).toBe(200)
    },
    30 * MIN
  )

  it(
    'Длинный промпт без max_tokens: a prompt that leaves less room than the output limit is answered, not refused',
    async () => {
      // 8192 context, 4096 output limit: ~6000 prompt tokens with no max_tokens.
      const answer = await httpRequest({
        url: `http://127.0.0.1:${S.publicPort}/v1/chat/completions`,
        method: 'POST',
        body: JSON.stringify({
          model: S.model?.id,
          ...THINKING_OFF,
          messages: [{ role: 'user', content: `${'word '.repeat(5_800)}\nReply with OK.` }],
        }),
        timeoutMs: 10 * MIN,
      })
      expect(answer.status, answer.text).toBe(200)
    },
    30 * MIN
  )

  it(
    'Контейнер SGLang не обращается в сеть: no connection out of the container after chat, tools and thinking',
    async () => {
      const peers = await containerRemotePeers(ourContainerId())
      expect(peers, 'docker exec cat /proc/net/tcp*').not.toBeNull()
      S.summary['remote_tcp_peers'] = peers
      expect(peers).toEqual([])
    },
    5 * MIN
  )

  it(
    'Повторная загрузка той же модели: the second start reuses the compile cache and is faster',
    async () => {
      const unloaded = await core().api.post(`/models/sglang/${S.model?.id}/unload`, {}, 10 * MIN)
      expect(unloaded.status, unloaded.text).toBe(200)
      const second = await load()
      S.summary['second_load_ms'] = second.ms
      expect(second.ms).toBeLessThan(S.summary['first_load_ms'] as number)
    },
    2 * HOUR
  )
})
