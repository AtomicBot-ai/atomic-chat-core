/**
 * Live vLLM on a real Linux host (change `add-vllm-runtime`, task 3.5; specs `vllm-runtime`,
 * `managed-model-store`; design D8, D9). The rest of the suite proves the provider against a fake
 * Docker and a fake engine; this file is the only proof that a real `vllm serve` container from the
 * pinned `vllm/vllm-openai` image installs on the prepared environment, loads the curated
 * `Qwen/Qwen3.5-2B` from the managed model store with core's KV-cache bytes and memory share, streams
 * through the public server, answers with thinking off in `content` and with thinking on in
 * `reasoning_content`, calls a tool through its parser, refuses a request over its context with
 * `context_length_exceeded`, runs with no usage stats, Hugging Face offline and no remote code, and
 * starts faster the second time from its compile cache.
 *
 * It writes what task 6.1 carries into the change's rulings: `<out>/summary.json` (load and reload
 * times, the KV bytes and memory share the core passed, the card's memory) and `<out>/vllm-start.log`,
 * the engine's own log of the first start, which replaces the constructed lines of
 * `test/helpers/vllm-log-fixtures.ts`.
 *
 * It drives the compiled core only (no `src/` imports). It installs the vLLM engine if it is not
 * `ready` yet, but only on an environment that needs no privileged step (Docker with the NVIDIA runtime
 * already there — the TensorRT-LLM install test, or the app, prepared it); otherwise it stops and says so.
 *
 * Runs only with ATOMIC_LIVE=1 on Linux with `/usr/bin/nvidia-smi`; anywhere else every scenario is
 * skipped with that reason. Optional: ATOMIC_LIVE_CORE_BIN, ATOMIC_RUNTIME_DESCRIPTOR_URL_VLLM and
 * ATOMIC_ENVIRONMENT_MANIFEST_URL (default: the conf fixture copies in this repo), ATOMIC_LIVE_MANAGED_ROOT,
 * ATOMIC_LIVE_OUT, ATOMIC_LIVE_MODEL_CACHE, ATOMIC_LIVE_GPU (a card's UUID; default the core's choice),
 * HF_ENDPOINT, HF_TOKEN. The core runs with DO_NOT_TRACK=1: a test run sends no error reports.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { httpRequest, pollOperation, startLiveCore, streamChat } from '../helpers/live-core.js'
import type { LiveCore, OperationView } from '../helpers/live-core.js'
import { inspectContainer, ownContainers } from '../helpers/live-engine.js'
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
  process.env['ATOMIC_RUNTIME_DESCRIPTOR_URL_VLLM'] ??
  pathToFileURL(join(ROOT, 'test/fixtures/runtimes/vllm.json')).href
const MANIFEST_URL =
  process.env['ATOMIC_ENVIRONMENT_MANIFEST_URL'] ??
  pathToFileURL(join(ROOT, 'test/fixtures/runtimes/environments/linux.json')).href
const MODEL_CACHE =
  process.env['ATOMIC_LIVE_MODEL_CACHE'] ?? join(homedir(), '.cache', 'atomic-chat-live', 'hf')
const GPU = process.env['ATOMIC_LIVE_GPU']
const MODEL = 'Qwen/Qwen3.5-2B'
const MIN = 60_000
const HOUR = 60 * MIN
const TARGET = { kind: 'runtime', installation_id: 'vllm', engine_id: 'vllm' }

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
  console.log(`[live vllm] ${line}`)
}

async function load(): Promise<{ session: Session; ms: number }> {
  const started = Date.now()
  const answer = await core().api.post<{ session: Session }>(`/models/vllm/${S.model?.id}/load`, {}, 2 * HOUR)
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

/** The one container of this core's vLLM session, inspected as root. */
async function ourContainer() {
  const ids = ownContainers(core().ready.instance_id)
  expect(ids.length, 'one model container of this core').toBe(1)
  const facts = await inspectContainer(ids[0] as string)
  expect(facts).not.toBeNull()
  return facts as NonNullable<typeof facts>
}

describe.skipIf(!ENABLED)('live vLLM (ATOMIC_LIVE=1)', () => {
  beforeAll(async () => {
    const name = new Date().toISOString().replace(/[:.]/g, '-')
    S.out = process.env['ATOMIC_LIVE_OUT'] ?? join(ROOT, 'test/tmp/live-vllm', name)
    S.dataFolder = join(S.out, 'data')
    mkdirSync(S.dataFolder, { recursive: true })
    S.descriptor = await readDescriptor<Descriptor>(DESCRIPTOR_URL, 'vLLM descriptor')
    S.core = await startLiveCore({
      label: 'vllm',
      bin: BIN,
      dataFolder: S.dataFolder,
      env: {
        ATOMIC_RUNTIME_DESCRIPTOR_URL_VLLM: DESCRIPTOR_URL,
        ATOMIC_ENVIRONMENT_MANIFEST_URL: MANIFEST_URL,
        DO_NOT_TRACK: '1',
        ...(process.env['ATOMIC_LIVE_MANAGED_ROOT'] === undefined
          ? {}
          : { ATOMIC_CORE_MANAGED_ROOT: process.env['ATOMIC_LIVE_MANAGED_ROOT'] }),
      },
      logFile: join(S.out, 'core.log'),
    })
    if (GPU !== undefined) await core().api.patch('/settings/vllm', { values: { gpu_id: GPU } })
  }, 5 * MIN)

  afterAll(async () => {
    writeFileSync(join(S.out, 'summary.json'), `${JSON.stringify(S.summary, null, 2)}\n`)
    if (S.model !== null)
      await core()
        .api.post(`/models/vllm/${S.model.id}/unload`, {}, 10 * MIN)
        .catch(() => null)
    await S.core?.stop()
  }, 15 * MIN)

  it(
    'setup: vLLM installs on the prepared environment with no privileged step (or is ready already)',
    async () => {
      const snapshot = await core().api.get<{
        environments: { installations: { engine_id: string; status: string }[] }[]
      }>('/snapshot')
      const installed = snapshot.body.environments[0]?.installations.find((i) => i.engine_id === 'vllm')
      if (installed?.status === 'ready') {
        log('vLLM is installed already')
        return
      }
      const started = Date.now()
      const begun = await core().api.post<OperationView>('/environments/default/operations', {
        request_id: `live-vllm-${Date.now()}`,
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
    'load: the curated Qwen3.5-2B from the store, pinned to its card, with core’s KV bytes and memory share',
    async () => {
      const curated = S.descriptor?.curated_models.find((model) => model.repository === MODEL)
      expect(curated, `${MODEL} is curated in the vLLM descriptor`).toBeDefined()
      S.model = await prepareCuratedModel({
        api: core().api,
        model: curated as CuratedModel,
        gpuId: GPU,
        dataFolder: S.dataFolder,
        cacheRoot: MODEL_CACHE,
        log,
        provider: 'vllm',
      })
      // Free on the card as core last probed it, before the container: with vLLM's own reading at its
      // start check (below) it shows what vLLM's CUDA context takes on this host.
      const environments = await core().api.get<{ environments: { gpus: GpuFacts[] }[] }>('/environments')
      const card = environments.body.environments[0]?.gpus.find((gpu) => gpu.gpu_id === GPU)
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
    'the container: no usage stats, Hugging Face offline, no remote code, a read-only model, isolation flags',
    async () => {
      const facts = await ourContainer()
      expect(facts.env).toMatchObject({ VLLM_NO_USAGE_STATS: '1', DO_NOT_TRACK: '1', HF_HUB_OFFLINE: '1' })
      expect(facts.command).not.toContain('--trust-remote-code')
      expect(facts.command).not.toContain('--enable-log-requests')
      expect(facts.command).not.toContain('--api-key')
      expect(facts.mounts.find((m) => m.destination === '/atomic/model')).toMatchObject({ rw: false })
      expect(facts.mounts.find((m) => m.destination === '/atomic/engine-cache')).toMatchObject({ rw: true })
      expect(facts.mounts.some((m) => m.source.endsWith('docker.sock'))).toBe(false)
      expect(facts.privileged).toBe(false)
      expect(facts.ipc_mode).not.toBe('host')
      expect(facts.restart_policy).toBe('no')
      expect(facts.published_host_ips.every((ip) => ip === '127.0.0.1')).toBe(true)
      const flag = (name: string) => facts.command[facts.command.indexOf(name) + 1]
      S.summary['kv_cache_memory_bytes'] = Number(flag('--kv-cache-memory-bytes'))
      S.summary['gpu_memory_utilization'] = Number(flag('--gpu-memory-utilization'))
      S.summary['shm_size_bytes'] = facts.shm_size_bytes
      // The engine's own first-start log, for test/helpers/vllm-log-fixtures.ts (task 6.1).
      const logs = await core().api.get<{ log_tail: string }>(`/models/vllm/${S.model?.id}/logs`)
      writeFileSync(join(S.out, 'vllm-start.log'), logs.body.log_tail)
      // vLLM's own free-memory reading at its start check, after its CUDA context exists.
      const atCheck = /Initial free memory ([\d.]+) GiB/.exec(logs.body.log_tail)
      S.summary['vllm_free_gib_at_start_check'] = atCheck === null ? null : Number(atCheck[1])
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
    'Qwen3.5 без размышлений: the answer is in content, reasoning empty — whole and streamed',
    async () => {
      const plain = await chat({
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
          messages: [{ role: 'user', content: 'What is 2 + 2?' }],
        },
        timeoutMs: 10 * MIN,
      })
      expect(streamed.content).toMatch(/4/)
      expect(streamed.reasoning).toBe('')
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
    'Повторная загрузка той же модели: the second start reuses the compile cache and is faster',
    async () => {
      const unloaded = await core().api.post(`/models/vllm/${S.model?.id}/unload`, {}, 10 * MIN)
      expect(unloaded.status, unloaded.text).toBe(200)
      const second = await load()
      S.summary['second_load_ms'] = second.ms
      expect(second.ms).toBeLessThan(S.summary['first_load_ms'] as number)
    },
    2 * HOUR
  )
})
