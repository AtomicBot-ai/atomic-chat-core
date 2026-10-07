/**
 * `POST /atomic/v1/models/vllm/check` through the compiled binary (change `add-vllm-runtime`, task 3.4;
 * spec `managed-model-store`, "Проверка совместимости одинакова по форме для всех managed-движков";
 * `runtime-descriptor-catalog`, "Локальный дескриптор в разработке"): vLLM's own descriptor — from
 * `ATOMIC_RUNTIME_DESCRIPTOR_URL_VLLM`, or its cache when vLLM is not installed — vLLM's memory rule,
 * the same answer shape as `tensorrt-llm`'s check, no Docker. A fake `docker` is installed, so "never
 * calls Docker" is falsifiable: `docker.json` would exist.
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
const VLLM = fileURLToPath(new URL('../fixtures/runtimes/vllm.json', import.meta.url))
const TRT = fileURLToPath(new URL('../fixtures/runtimes/tensorrt-llm.json', import.meta.url))
const VLLM_ID = (JSON.parse(readFileSync(VLLM, 'utf8')) as { descriptor_id: string }).descriptor_id
const TRT_ID = (JSON.parse(readFileSync(TRT, 'utf8')) as { descriptor_id: string }).descriptor_id

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
  dataFolder = await mkdtemp(join(tmpdir(), 'atomic-core-e2e-vllm-check-'))
  managedRoot = await mkdtemp(join(tmpdir(), 'atomic-managed-e2e-vllm-check-'))
  host = await mkdtemp(join(tmpdir(), 'atomic-vllm-check-host-'))
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
    ...env,
  })

/**
 * A probe for a vLLM setup: the one path that reads a descriptor's source, local file included. The
 * check never does (it reads the cache alone, spec "Core MUST NOT обращаться в сеть при проверке").
 */
const probeVllm = (ready: ReadyLine) =>
  core.control(dataFolder, ready, '/environments/probe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      descriptor_id: VLLM_ID,
      target: { kind: 'runtime', installation_id: 'vllm', engine_id: 'vllm' },
    }),
  })

const check = (ready: ReadyLine, provider: string, body: unknown) =>
  core.control(dataFolder, ready, `/models/${provider}/check`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

/** A 4-bit AutoAWQ Llama: vLLM reads it, TensorRT-LLM does not. */
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

describe.skipIf(!existsSync(core.BIN) || process.platform === 'win32')('POST /models/vllm/check', () => {
  it('Локальный дескриптор в разработке: reads vLLM’s descriptor from ATOMIC_RUNTIME_DESCRIPTOR_URL_VLLM, with no Docker', async () => {
    const { ready } = await start({ ATOMIC_RUNTIME_DESCRIPTOR_URL_VLLM: pathToFileURL(VLLM).href })
    const probed = await probeVllm(ready)
    expect(probed.status, await probed.clone().text()).toBe(200)
    expect(await probed.json()).toMatchObject({ descriptor_id: VLLM_ID })
    const diagnostics = (await (
      await core.control(dataFolder, ready, '/environments/default/diagnostics')
    ).json()) as {
      sources: { engine_id?: string; overridden_by: string | null }[]
    }
    expect(diagnostics.sources.find((source) => source.engine_id === 'vllm')?.overridden_by).toBe(
      'ATOMIC_RUNTIME_DESCRIPTOR_URL_VLLM'
    )
    // The probe asked Docker about the machine; the check itself never does.
    const dockerCalls = () =>
      existsSync(join(host, 'docker.json'))
        ? (JSON.parse(readFileSync(join(host, 'docker.json'), 'utf8')) as { calls: string[] }).calls.length
        : 0
    const before = dockerCalls()
    const res = await check(ready, 'vllm', awq)
    expect(res.status, await res.clone().text()).toBe(200)
    expect(await res.json()).toMatchObject({ quantization_format: 'autoawq_w4a16', verdict: { ok: true } })
    expect(dockerCalls()).toBe(before)
  })

  it('Движок не установлен: checks by vLLM’s cached descriptor; one checkpoint, two verdicts in one shape', async () => {
    await cache(VLLM, VLLM_ID, 'vllm')
    await cache(TRT, TRT_ID, 'tensorrt-llm')
    const { ready } = await start({ ATOMIC_RUNTIME_DESCRIPTOR_URL_VLLM: 'https://127.0.0.1:9/vllm.json' })
    const viaVllm = (await (await check(ready, 'vllm', awq)).json()) as Record<string, unknown>
    const viaTrt = (await (await check(ready, 'tensorrt-llm', awq)).json()) as Record<string, unknown>
    // One shape: the same fields, `kv_reserve_basis` aside — it is only there once memory was sized.
    const fields = (answer: Record<string, unknown>) =>
      Object.keys(answer)
        .filter((key) => key !== 'kv_reserve_basis')
        .sort()
    expect(fields(viaVllm)).toEqual(fields(viaTrt))
    expect(viaVllm['verdict']).toEqual({ ok: true })
    expect(viaTrt['verdict']).toMatchObject({ ok: false, error: { code: 'MODEL_INCOMPATIBLE' } })
    expect(JSON.stringify(viaTrt['verdict'])).toContain('tensorrt-llm does not support \\"autoawq_w4a16\\"')
  })

  it('Модель не помещается: weights and KV over the card’s free memory — MODEL_INCOMPATIBLE with vLLM’s numbers', async () => {
    const { ready } = await start({ ATOMIC_RUNTIME_DESCRIPTOR_URL_VLLM: pathToFileURL(VLLM).href })
    await probeVllm(ready)
    const res = await check(ready, 'vllm', {
      ...awq,
      files: [{ path: 'model.safetensors', size: 30_000_000_000, sha256: 'a'.repeat(64) }],
    })
    const body = (await res.json()) as { verdict: { ok: boolean; error?: { code: string; details: string } } }
    expect(body.verdict.ok).toBe(false)
    expect(body.verdict.error?.code).toBe('MODEL_INCOMPATIBLE')
    expect(body.verdict.error?.details).toMatch(/kv_cache_bytes=\d+ .*needed_bytes=\d+ free_bytes=\d+/)
  })

  it('Дескриптора в main conf ещё нет: no vLLM descriptor at all is MANAGED_METADATA_INVALID, TensorRT-LLM still answers', async () => {
    await cache(TRT, TRT_ID, 'tensorrt-llm')
    const { ready } = await start({ ATOMIC_RUNTIME_DESCRIPTOR_URL_VLLM: 'https://127.0.0.1:9/vllm.json' })
    const vllm = await check(ready, 'vllm', awq)
    expect(await vllm.json()).toMatchObject({ error: { code: 'MANAGED_METADATA_INVALID' } })
    expect((await check(ready, 'tensorrt-llm', awq)).status).toBe(200)
  })
})
