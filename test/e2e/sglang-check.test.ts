/**
 * `POST /atomic/v1/models/sglang/check` through the compiled binary (change `add-sglang-runtime`,
 * task 2.4; spec `managed-model-store`, "Проверка совместимости одинакова по форме для всех
 * managed-движков"; `sglang-runtime`): SGLang's own descriptor — from
 * `ATOMIC_RUNTIME_DESCRIPTOR_URL_SGLANG`, or its cache when SGLang is not installed — SGLang's memory
 * rule, the same answer shape as `vllm`'s check, no Docker. And until conf main publishes
 * `runtimes/sglang.json` (a 404), the provider is unsupported while vLLM and TensorRT-LLM answer as
 * before. A fake `docker` is installed, so "never calls Docker" is falsifiable: `docker.json` would
 * exist.
 *
 * No imports from `src/`: a packaging change that breaks the route cannot pass by type-checking.
 */
import type { ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as core from '../helpers/compiled-core.js'
import type { ReadyLine } from '../helpers/compiled-core.js'

const FAKE_NVIDIA_SMI = fileURLToPath(new URL('../helpers/fake-nvidia-smi.mjs', import.meta.url))
const FAKE_DOCKER = fileURLToPath(new URL('../helpers/fake-model-docker.mjs', import.meta.url))
const SGLANG = fileURLToPath(new URL('../fixtures/runtimes/sglang.json', import.meta.url))
const VLLM = fileURLToPath(new URL('../fixtures/runtimes/vllm.json', import.meta.url))
const TRT = fileURLToPath(new URL('../fixtures/runtimes/tensorrt-llm.json', import.meta.url))
const idOf = (path: string) =>
  (JSON.parse(readFileSync(path, 'utf8')) as { descriptor_id: string }).descriptor_id
const SGLANG_ID = idOf(SGLANG)
const VLLM_ID = idOf(VLLM)
const TRT_ID = idOf(TRT)

let dataFolder: string
let managedRoot: string
let host: string
const daemons: ChildProcess[] = []

async function wrap(path: string, script: string, env: Record<string, string> = {}): Promise<void> {
  const exports = Object.entries(env)
    .map(([name, value]) => `export ${name}=${JSON.stringify(value)}\n`)
    .join('')
  await writeFile(
    path,
    `#!/bin/sh\n${exports}exec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`
  )
  await chmod(path, 0o755)
}

/** One engine's descriptor in the cache as its last accepted one, no installation. */
async function cache(path: string, id: string, engine: string): Promise<void> {
  await mkdir(join(managedRoot, 'descriptors'), { recursive: true })
  await copyFile(path, join(managedRoot, 'descriptors', `${id}.json`))
  await writeFile(
    join(managedRoot, 'descriptors', `latest-${engine}.json`),
    JSON.stringify({ descriptor_id: id })
  )
}

beforeEach(async () => {
  dataFolder = await mkdtemp(join(tmpdir(), 'atomic-core-e2e-sglang-check-'))
  managedRoot = await mkdtemp(join(tmpdir(), 'atomic-managed-e2e-sglang-check-'))
  host = await mkdtemp(join(tmpdir(), 'atomic-sglang-check-host-'))
  await mkdir(join(host, 'bin'))
  await wrap(join(host, 'bin', 'nvidia-smi'), FAKE_NVIDIA_SMI)
  await wrap(join(host, 'bin', 'docker'), FAKE_DOCKER, { FAKE_DOCKER_STATE: join(host, 'docker.json') })
})

afterEach(async () => {
  for (const daemon of daemons.splice(0)) daemon.kill('SIGKILL')
  for (const dir of [dataFolder, managedRoot, host])
    await rm(dir, { recursive: true, force: true, maxRetries: 3 })
})

const start = (env: Record<string, string> = {}) =>
  core.startDaemon(dataFolder, daemons, [], {
    ATOMIC_CORE_MANAGED_ROOT: managedRoot,
    ATOMIC_MANAGED_TEST_HOST: host,
    // No network in a test: an https source that cannot be reached falls back to the cache.
    ATOMIC_RUNTIME_DESCRIPTOR_URL_TENSORRT_LLM: 'https://127.0.0.1:9/tensorrt-llm.json',
    ATOMIC_RUNTIME_DESCRIPTOR_URL_VLLM: 'https://127.0.0.1:9/vllm.json',
    ...env,
  })

const target = (engine: string) => ({ kind: 'runtime', installation_id: engine, engine_id: engine })

/** A probe for a setup: the one path that reads a descriptor's source. The check never does. */
const probe = (ready: ReadyLine, engine: string, descriptorId: string) =>
  core.control(dataFolder, ready, '/environments/probe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ descriptor_id: descriptorId, target: target(engine) }),
  })

const check = (ready: ReadyLine, provider: string, body: unknown) =>
  core.control(dataFolder, ready, `/models/${provider}/check`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

/** A 4-bit AutoAWQ Llama: SGLang and vLLM read it, TensorRT-LLM does not. */
const awq = {
  repository: 'acme/llama-awq',
  revision: 'deadbeef',
  config_json: {
    architectures: ['LlamaForCausalLM'],
    dtype: 'float16',
    num_hidden_layers: 4,
    num_attention_heads: 8,
    num_key_value_heads: 2,
    head_dim: 64,
    quantization_config: { quant_method: 'awq', bits: 4, group_size: 128, version: 'gemm', zero_point: true },
  },
  hf_quant_config_json: null,
  files: [{ path: 'model.safetensors', size: 2_000_000_000, sha256: 'a'.repeat(64) }],
}

describe.skipIf(!existsSync(core.BIN) || process.platform === 'win32')('POST /models/sglang/check', () => {
  it('Локальный дескриптор в разработке: reads SGLang’s descriptor from ATOMIC_RUNTIME_DESCRIPTOR_URL_SGLANG, with no Docker', async () => {
    const { ready } = await start({ ATOMIC_RUNTIME_DESCRIPTOR_URL_SGLANG: pathToFileURL(SGLANG).href })
    const probed = await probe(ready, 'sglang', SGLANG_ID)
    expect(probed.status, await probed.clone().text()).toBe(200)
    expect(await probed.json()).toMatchObject({ descriptor_id: SGLANG_ID })
    const diagnostics = (await (
      await core.control(dataFolder, ready, '/environments/default/diagnostics')
    ).json()) as {
      sources: { engine_id?: string; overridden_by: string | null }[]
    }
    expect(diagnostics.sources.find((source) => source.engine_id === 'sglang')?.overridden_by).toBe(
      'ATOMIC_RUNTIME_DESCRIPTOR_URL_SGLANG'
    )
    // The probe asked Docker about the machine; the check itself never does.
    const dockerCalls = () =>
      existsSync(join(host, 'docker.json'))
        ? (JSON.parse(readFileSync(join(host, 'docker.json'), 'utf8')) as { calls: string[] }).calls.length
        : 0
    const before = dockerCalls()
    const res = await check(ready, 'sglang', awq)
    expect(res.status, await res.clone().text()).toBe(200)
    expect(await res.json()).toMatchObject({ quantization_format: 'autoawq_w4a16', verdict: { ok: true } })
    expect(dockerCalls()).toBe(before)
  })

  it('Движок не установлен: checks by SGLang’s cached descriptor; one checkpoint, three verdicts in one shape', async () => {
    await cache(SGLANG, SGLANG_ID, 'sglang')
    await cache(VLLM, VLLM_ID, 'vllm')
    await cache(TRT, TRT_ID, 'tensorrt-llm')
    const { ready } = await start({ ATOMIC_RUNTIME_DESCRIPTOR_URL_SGLANG: 'https://127.0.0.1:9/sglang.json' })
    const answers = await Promise.all(
      ['sglang', 'vllm', 'tensorrt-llm'].map(
        async (provider) => (await (await check(ready, provider, awq)).json()) as Record<string, unknown>
      )
    )
    const [viaSglang, viaVllm, viaTrt] = answers
    // One shape: the same fields, `kv_reserve_basis` aside — it is only there once memory was sized.
    const fields = (answer: Record<string, unknown> | undefined) =>
      Object.keys(answer ?? {})
        .filter((key) => key !== 'kv_reserve_basis')
        .sort()
    expect(fields(viaSglang)).toEqual(fields(viaVllm))
    expect(fields(viaSglang)).toEqual(fields(viaTrt))
    expect(viaSglang?.['verdict']).toEqual({ ok: true })
    expect(viaVllm?.['verdict']).toEqual({ ok: true })
    expect(viaTrt?.['verdict']).toMatchObject({ ok: false, error: { code: 'MODEL_INCOMPATIBLE' } })
  })

  it('Модель не помещается: weights and KV over the card’s free memory — MODEL_INCOMPATIBLE with SGLang’s numbers', async () => {
    const { ready } = await start({ ATOMIC_RUNTIME_DESCRIPTOR_URL_SGLANG: pathToFileURL(SGLANG).href })
    await probe(ready, 'sglang', SGLANG_ID)
    const res = await check(ready, 'sglang', {
      ...awq,
      files: [{ path: 'model.safetensors', size: 30_000_000_000, sha256: 'a'.repeat(64) }],
    })
    const body = (await res.json()) as { verdict: { ok: boolean; error?: { code: string; details: string } } }
    expect(body.verdict.ok).toBe(false)
    expect(body.verdict.error?.code).toBe('MODEL_INCOMPATIBLE')
    expect(body.verdict.error?.details).toMatch(
      /kv_cache_bytes=\d+ .*engine_overhead_bytes=\d+ .*needed_bytes=\d+ free_bytes=\d+/
    )
  })

  it('Модель с собственным кодом: an architecture SGLang does not list, with auto_map — MODEL_INCOMPATIBLE naming it', async () => {
    const { ready } = await start({ ATOMIC_RUNTIME_DESCRIPTOR_URL_SGLANG: pathToFileURL(SGLANG).href })
    await probe(ready, 'sglang', SGLANG_ID)
    const res = await check(ready, 'sglang', {
      ...awq,
      config_json: {
        ...awq.config_json,
        architectures: ['FancyRemoteForCausalLM'],
        auto_map: { AutoModelForCausalLM: 'modeling_fancy.FancyRemoteForCausalLM' },
      },
    })
    const body = (await res.json()) as { verdict: { ok: boolean; error?: { code: string; message: string } } }
    expect(body.verdict).toMatchObject({ ok: false, error: { code: 'MODEL_INCOMPATIBLE' } })
    expect(JSON.stringify(body.verdict.error)).toContain('FancyRemoteForCausalLM')
  })

  // conf main has no runtimes/sglang.json until the live acceptance (design D9): the source yields no
  // document and nothing is cached. (A conf 404 itself is the descriptor provider's unit test: overrides
  // accept only file:// and https://.)
  it('Дескриптор SGLang ещё не опубликован: no document and no cache — SGLang is unsupported, vLLM and TensorRT-LLM answer as before', async () => {
    await cache(VLLM, VLLM_ID, 'vllm')
    await cache(TRT, TRT_ID, 'tensorrt-llm')
    const { ready } = await start({
      ATOMIC_RUNTIME_DESCRIPTOR_URL_SGLANG: pathToFileURL(join(managedRoot, 'not-published', 'sglang.json'))
        .href,
    })

    const probed = await probe(ready, 'sglang', SGLANG_ID)
    expect(await probed.json()).toMatchObject({ availability: 'unsupported' })
    expect(await (await check(ready, 'sglang', awq)).json()).toMatchObject({
      error: { code: 'MANAGED_METADATA_INVALID' },
    })
    // Nothing is installed, so a load is refused before any container.
    const load = await core.control(dataFolder, ready, '/models/sglang/m/load', { method: 'POST' })
    expect(await load.json()).toMatchObject({ error: { code: 'MANAGED_ADAPTER_UNAVAILABLE' } })
    const calls = existsSync(join(host, 'docker.json'))
      ? (JSON.parse(readFileSync(join(host, 'docker.json'), 'utf8')) as { calls: string[] }).calls
      : []
    expect(calls).not.toContain('create')
    expect((await check(ready, 'vllm', awq)).status).toBe(200)
    expect((await check(ready, 'tensorrt-llm', awq)).status).toBe(200)
  })
})
