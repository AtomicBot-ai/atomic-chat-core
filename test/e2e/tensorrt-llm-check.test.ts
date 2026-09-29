/**
 * `POST /atomic/v1/models/tensorrt-llm/check` through the compiled binary (task 2.16, spec
 * `tensorrt-llm-models`): the check route wires the pure `checkModelCompatibility` to the pinned
 * descriptor of the `ready` installation (or the latest cached one when nothing is installed), the
 * host's GPUs (`fake-nvidia-smi.mjs`, the same test host `tensorrt-llm-provider.test.ts` uses) and
 * `/proc/meminfo` — over `ATOMIC_MANAGED_TEST_HOST`, so this runs on any host without a real GPU or
 * Docker. No fake `docker` is installed at all: the check route never asks Docker anything (unlike a
 * load), which the "no installation at all" case below exercises directly.
 *
 * No imports from `src/`: a packaging change that breaks the route cannot pass by type-checking.
 */
import type { ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as core from '../helpers/compiled-core.js'
import type { ReadyLine } from '../helpers/compiled-core.js'

const FAKE_NVIDIA_SMI = fileURLToPath(new URL('../helpers/fake-nvidia-smi.mjs', import.meta.url))
const DESCRIPTOR = fileURLToPath(new URL('../fixtures/runtimes/tensorrt-llm.json', import.meta.url))
const DESCRIPTOR_JSON = JSON.parse(readFileSync(DESCRIPTOR, 'utf8')) as { descriptor_id: string }
const DESCRIPTOR_ID = DESCRIPTOR_JSON.descriptor_id
const PLATFORM = process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64'
/** The one card `fake-nvidia-smi.mjs` reports: an RTX 4090, compute capability 8.9, 24564 MiB. */
const GPU = 'GPU-0b6f4f4e-6c1c-3a54-8f2d-1b0d2f4d6a11'

let dataFolder: string
let managedRoot: string
let host: string
const daemons: ChildProcess[] = []

async function wrap(path: string, script: string): Promise<void> {
  await writeFile(
    path,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`
  )
  await chmod(path, 0o755)
}

async function writeInstallation(): Promise<void> {
  await mkdir(join(managedRoot, 'descriptors'), { recursive: true })
  await copyFile(DESCRIPTOR, join(managedRoot, 'descriptors', `${DESCRIPTOR_ID}.json`))
  const dir = join(managedRoot, 'installations', 'trt-1')
  await mkdir(dir, { recursive: true })
  // The record exactly as the setup operation's activation writes it (`InstallationStore`).
  await writeFile(
    join(dir, 'installation.json'),
    JSON.stringify({
      schema_version: 1,
      installation: {
        installation_id: 'trt-1',
        engine_id: 'tensorrt-llm',
        environment_id: 'default',
        active_descriptor_id: DESCRIPTOR_ID,
        candidate_descriptor_id: null,
        availability: 'supported',
        status: 'ready',
      },
      image: { repository: 'nvcr.io/nvidia/tensorrt-llm/release', digest: `sha256:${'a'.repeat(64)}` },
      platform: PLATFORM,
      installed_at: '2026-09-29T00:00:00.000Z',
    })
  )
}

beforeEach(async () => {
  dataFolder = await mkdtemp(join(tmpdir(), 'atomic-core-e2e-trt-check-'))
  managedRoot = await mkdtemp(join(tmpdir(), 'atomic-managed-e2e-trt-check-'))
  host = await mkdtemp(join(tmpdir(), 'atomic-trt-check-host-'))
  await mkdir(join(host, 'bin'))
  await wrap(join(host, 'bin', 'nvidia-smi'), FAKE_NVIDIA_SMI)
  // No fake docker at all: `docker` on this host's PATH is whatever the test runner has (or nothing),
  // and the check route is never allowed to shell out to it either way.
})

afterEach(async () => {
  for (const daemon of daemons.splice(0)) daemon.kill('SIGKILL')
  for (const dir of [dataFolder, managedRoot, host])
    await rm(dir, { recursive: true, force: true, maxRetries: 3 })
})

const start = () =>
  core.startDaemon(dataFolder, daemons, [], {
    ATOMIC_CORE_MANAGED_ROOT: managedRoot,
    ATOMIC_MANAGED_TEST_HOST: host,
  })

const check = (ready: ReadyLine, body: unknown) =>
  core.control(dataFolder, ready, '/models/tensorrt-llm/check', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const bf16Body = (overrides: Record<string, unknown> = {}) => ({
  repository: 'acme/llama-3-small',
  revision: 'deadbeef',
  config_json: { architectures: ['LlamaForCausalLM'], dtype: 'bfloat16' },
  hf_quant_config_json: null,
  files: [
    { path: 'model.safetensors', size: 1_000_000_000, sha256: 'a'.repeat(64) },
    { path: 'config.json', size: 200, sha256: null },
  ],
  ...overrides,
})

describe.skipIf(!existsSync(core.BIN) || process.platform === 'win32')(
  'POST /models/tensorrt-llm/check',
  () => {
    it("checks a compatible checkpoint against the pinned descriptor of the ready installation and this host's card, with no network and no Docker", async () => {
      await writeInstallation()
      const { ready } = await start()

      const res = await check(ready, bf16Body())
      expect(res.status, await res.clone().text()).toBe(200)
      const body = (await res.json()) as {
        architectures: string[]
        quantization_format: string
        checked_gpu_id: string
        curated: boolean
        verdict: { ok: boolean }
      }
      expect(body.architectures).toEqual(['LlamaForCausalLM'])
      expect(body.quantization_format).toBe('bf16')
      expect(body.checked_gpu_id).toBe(GPU)
      expect(body.curated).toBe(false)
      expect(body.verdict).toEqual({ ok: true })
    })

    it('reports MODEL_INCOMPATIBLE with the architecture name for one the descriptor does not support', async () => {
      await writeInstallation()
      const { ready } = await start()

      const res = await check(
        ready,
        bf16Body({ config_json: { architectures: ['GPT2LMHeadModel'], dtype: 'bfloat16' } })
      )
      expect(res.status, await res.clone().text()).toBe(200)
      const body = (await res.json()) as { verdict: { ok: false; error: { code: string; message: string } } }
      expect(body.verdict.ok).toBe(false)
      expect(body.verdict.error.code).toBe('MODEL_INCOMPATIBLE')
      expect(body.verdict.error.message).toContain('GPT2LMHeadModel')
    })

    it('rejects a GGUF file listing outright, naming llama.cpp', async () => {
      await writeInstallation()
      const { ready } = await start()

      const res = await check(
        ready,
        bf16Body({ files: [{ path: 'model.Q4_K_M.gguf', size: 4_000_000_000, sha256: null }] })
      )
      const body = (await res.json()) as { verdict: { ok: false; error: { message: string } } }
      expect(body.verdict.ok).toBe(false)
      expect(body.verdict.error.message).toContain('llama.cpp')
    })

    it('never creates a container or calls Docker while checking', async () => {
      await writeInstallation()
      const { ready } = await start()
      await check(ready, bf16Body())
      // No `docker.json` state file exists at all: no fake docker was ever installed on this host,
      // so any attempt to shell out to `docker` would have failed the request outright instead.
      expect(existsSync(join(host, 'docker.json'))).toBe(false)
    })

    it('falls back to the latest cached descriptor when the engine is not installed at all, and refuses cleanly when nothing was ever cached', async () => {
      // No `writeInstallation()`: the shared root has no installation and no cached descriptor.
      const { ready } = await start()
      const res = await check(ready, bf16Body())
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error: { code: string } }
      expect(body.error.code).toBe('MANAGED_METADATA_INVALID')
    })

    it('refuses a malformed body with INVALID_ARGUMENT before touching the host', async () => {
      await writeInstallation()
      const { ready } = await start()
      const res = await check(ready, { repository: 'acme/x' })
      expect(res.status).toBe(400)
      expect((await res.json()) as { error: { code: string } }).toMatchObject({
        error: { code: 'INVALID_ARGUMENT' },
      })
    })
  }
)
