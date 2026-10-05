/**
 * The PrismML model setup through the compiled binary (ADR
 * 2026-10-05-prismml-provider-compatibility-gate-and-model-setup): a Prism-only file is reported as
 * needing the engine, planned, set up in one operation (pack install with its launch check, model
 * download, header check, `model.yml`), refused on the stock engine and loaded on `atomic-prism`. A
 * setup a killed core left mid-download is `interrupted` after the restart and finishes on `resume`.
 *
 * The conf manifest, the model rules and the Hub are one local fixture server, reached through the
 * test hooks `ATOMIC_PRISM_MANIFEST_URL`, `ATOMIC_PRISM_MODEL_RULES_URL` and `ATOMIC_HF_ENDPOINT`.
 * No imports from `src/`. POSIX only (the fake engine is a shell script), and only on the hosts the
 * PrismML matrix has a build for.
 */
import type { ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { c as tarCreate } from 'tar'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as core from '../helpers/compiled-core.js'
import type { ReadyLine } from '../helpers/compiled-core.js'
import { FixtureHttpServer } from '../helpers/fixture-http-server.js'
import { BPW, bonsaiLikeGguf } from '../helpers/gguf-builder.js'

const { BIN } = core

const TAG = 'prism-b10754-2459f68'
const REPO = 'atomic-e2e/Bonsai-gguf'
const REVISION = 'a'.repeat(40)
const FILE = 'Bonsai-PQ2_0.gguf'
const MODEL_ID = 'atomic-e2e/Bonsai-PQ2_0'
const PRISM_BACKEND =
  process.platform === 'darwin'
    ? `macos-${process.arch === 'arm64' ? 'arm64' : 'x64'}`
    : process.platform === 'linux' && process.arch === 'x64'
      ? 'linux-cpu-x64'
      : null

let dataFolder: string
let scratch: string
let server: FixtureHttpServer
const daemons: ChildProcess[] = []

beforeEach(async () => {
  dataFolder = await mkdtemp(join(tmpdir(), 'atomic-core-e2e-setup-'))
  scratch = await mkdtemp(join(tmpdir(), 'atomic-core-e2e-setup-fixture-'))
  server = new FixtureHttpServer()
  await server.start()
})
afterEach(async () => {
  for (const daemon of daemons.splice(0)) daemon.kill('SIGKILL')
  core.reapJournalledChildren(dataFolder)
  await server.stop()
  await rm(dataFolder, { recursive: true, force: true })
  await rm(scratch, { recursive: true, force: true })
})

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex')

/** The pack as PrismML ships it: one `llama-prism-*` directory; `--version` names the tag's build. */
async function prismPack(): Promise<Buffer> {
  const top = join(scratch, 'pack')
  const dir = join(top, `llama-${TAG}`)
  await mkdir(dir, { recursive: true })
  const exe = join(dir, 'llama-server')
  await writeFile(
    exe,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "version: 10754 (2459f68)" >&2; exit 0; fi\n` +
      `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(core.FAKE_LLAMA)} "$@"\n`
  )
  await chmod(exe, 0o755)
  const archive = join(scratch, 'pack.tar.gz')
  await tarCreate({ gzip: true, file: archive, cwd: top }, [`llama-${TAG}`])
  return readFile(archive)
}

/** Serve the manifest, the rules, the pack and the model; returns the daemon's test hooks. */
async function serveFixtures(gguf: Buffer, ggufDelayMs = 0): Promise<NodeJS.ProcessEnv> {
  const pack = await prismPack()
  const assetName = `llama-${TAG}-bin-${PRISM_BACKEND}.tar.gz`
  const manifest = {
    schema_version: 1,
    updated_at: '2026-10-05T00:00:00Z',
    upstream_repo: 'PrismML-Eng/llama.cpp',
    download_base: server.url('/releases'),
    releases: [
      {
        tag: TAG,
        commit: '2459f68b5c0eb26261fd5a81682004b93cd645ba',
        published_at: '2026-10-02T00:00:00Z',
        min_core_version: '0.1.0',
        notes_url: `https://github.com/PrismML-Eng/llama.cpp/releases/tag/${TAG}`,
        capabilities: ['q1_0', 'q2_0_g64', 'pq2_0', 'ptq1_0', 'hadamard', 'vision'],
        assets: [
          {
            backend: PRISM_BACKEND,
            name: assetName,
            size: pack.length,
            sha256: sha256(pack),
            validation: 'approved',
          },
        ],
      },
    ],
  }
  const rules = {
    schema_version: 1,
    updated_at: '2026-10-05T00:00:00Z',
    rules_version: 7,
    tensor_types: { '41': 'q1_0', '42': 'q2_0', '142': 'pq2_0', '143': 'ptq1_0' },
    metadata_capabilities: { 'prism.hadamard.version': 'hadamard' },
    upstream_capabilities: ['q1_0', 'q2_0_g64'],
    families: [
      {
        id: 'atomic-e2e-bonsai',
        title: 'E2E Bonsai',
        repo: REPO,
        revision: REVISION,
        default_packing: 'pq2_0',
        default_ctx: 4096,
        files: [
          {
            file: FILE,
            size: gguf.length,
            sha256: sha256(gguf),
            packing: 'pq2_0',
            treatment: 'prism_required',
            requires: ['pq2_0', 'hadamard'],
            min_prism_build: 10754,
            default: true,
          },
        ],
      },
    ],
  }
  server.files.set('/conf/manifest.json', { body: Buffer.from(JSON.stringify(manifest)) })
  server.files.set('/conf/rules.json', { body: Buffer.from(JSON.stringify(rules)) })
  server.files.set(`/releases/${TAG}/${assetName}`, { body: pack })
  server.files.set(`/hf/${REPO}/resolve/${REVISION}/${FILE}`, {
    body: gguf,
    ...(ggufDelayMs ? { delayMs: ggufDelayMs } : {}),
  })
  return {
    ATOMIC_PRISM_MANIFEST_URL: server.url('/conf/manifest.json'),
    ATOMIC_PRISM_MODEL_RULES_URL: server.url('/conf/rules.json'),
    ATOMIC_HF_ENDPOINT: server.url('/hf'),
  }
}

const bonsai = () =>
  bonsaiLikeGguf({ weightType: 142, bitsPerWeight: BPW.pq2_0, metadata: { 'prism.hadamard.version': 1 } })

const call = (ready: ReadyLine, path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') =>
  core.control(dataFolder, ready, path, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

async function prepare(ready: ReadyLine): Promise<void> {
  // A CPU-only machine, described through the seam so every host picks the same pack.
  expect(
    (await call(ready, '/hardware/override', { gpus: [], cpu_extensions: ['avx', 'avx2'] }, 'PUT')).status
  ).toBe(200)
  for (const provider of ['atomic-prism', 'llamacpp-upstream']) {
    const res = await call(ready, `/settings/${provider}`, { values: { fit: false } }, 'PATCH')
    expect(res.status, await res.clone().text()).toBe(200)
  }
}

interface Setup {
  setup_id: string
  stage: string
  stopped_at?: string
  error?: { code: string; message: string }
}

async function waitForStage(
  ready: ReadyLine,
  setupId: string,
  stages: string[],
  timeoutMs = 60_000
): Promise<Setup> {
  const deadline = Date.now() + timeoutMs
  let last: Setup | undefined
  while (Date.now() < deadline) {
    last = (await (await call(ready, `/model-setups/${setupId}`)).json()) as Setup
    if (stages.includes(last.stage)) return last
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`setup ${setupId} never reached ${stages.join('|')}: ${JSON.stringify(last)}`)
}

async function plan(ready: ReadyLine): Promise<{ digest: string; engine: unknown; blockers: unknown[] }> {
  const res = await call(ready, '/models/setup-plan', { repo: REPO, file: FILE })
  expect(res.status, await res.clone().text()).toBe(200)
  return (await res.json()) as { digest: string; engine: unknown; blockers: unknown[] }
}

describe.skipIf(!existsSync(BIN) || process.platform === 'win32' || PRISM_BACKEND === null)(
  'PrismML model setup',
  () => {
    it('reports, plans and sets up a Prism-only file, refuses it upstream and loads it on atomic-prism', async () => {
      const env = await serveFixtures(bonsai())
      await core.writeFakeBackend(dataFolder)
      const { ready } = await core.startDaemon(dataFolder, daemons, [], env)
      await prepare(ready)

      const verdict = (await (
        await call(ready, '/models/compatibility', { repo: REPO, file: FILE })
      ).json()) as {
        outcome: string
        provider: string | null
        evidence: string
        defaults?: { ctx_len?: number }
      }
      expect(verdict).toMatchObject({
        outcome: 'engine_required',
        provider: 'atomic-prism',
        evidence: 'rules',
        defaults: { ctx_len: 4096 },
      })

      const planned = await plan(ready)
      expect(planned.blockers).toEqual([])
      expect(planned.engine).toMatchObject({
        provider: 'atomic-prism',
        version: TAG,
        backend: PRISM_BACKEND,
        installed: false,
      })

      const body = { repo: REPO, file: FILE, request_id: 'e2e-1', plan_digest: planned.digest }
      const stale = await call(ready, '/model-setups', { ...body, request_id: 'e2e-0', plan_digest: 'stale' })
      expect(stale.status).toBe(409)
      expect(((await stale.json()) as { error: { code: string } }).error.code).toBe('MODEL_SETUP_PLAN_STALE')

      const started = await call(ready, '/model-setups', body)
      expect(started.status, await started.clone().text()).toBe(202)
      const { setup_id: setupId } = (await started.json()) as Setup
      expect(((await (await call(ready, '/model-setups', body)).json()) as Setup).setup_id).toBe(setupId)

      const done = await waitForStage(ready, setupId, ['ready', 'failed', 'cancelled'])
      expect(done, JSON.stringify(done)).toMatchObject({ stage: 'ready' })

      const yml = await readFile(
        join(dataFolder, 'llamacpp', 'models', ...MODEL_ID.split('/'), 'model.yml'),
        'utf8'
      )
      expect(yml).toContain(`model_path: llamacpp/models/${MODEL_ID}/${FILE}`)
      expect(yml).toContain('atomic_runtime:')
      expect(yml).toContain('provider: atomic-prism')
      expect(
        existsSync(
          join(dataFolder, 'atomic-prism', 'backends', TAG, PRISM_BACKEND!, 'build', 'bin', 'llama-server')
        )
      ).toBe(true)
      const settings = (await (await call(ready, '/settings/atomic-prism')).json()) as {
        values?: Record<string, unknown>
      }
      expect(JSON.stringify(settings)).toContain(`${TAG}/${PRISM_BACKEND}`)
      const snapshot = (await (await call(ready, '/snapshot')).json()) as { model_setups: Setup[] }
      expect(snapshot.model_setups.map((s) => s.stage)).toEqual(['ready'])

      // The stock engine is refused before anything starts; nothing is loaded or journalled.
      const upstream = await call(ready, `/models/llamacpp-upstream/${MODEL_ID}/load`, {})
      expect(upstream.status).toBe(422)
      expect(((await upstream.json()) as { error: { code: string } }).error.code).toBe(
        'MODEL_ENGINE_INCOMPATIBLE'
      )
      expect((await (await call(ready, '/sessions')).json()) as object).toMatchObject({ sessions: [] })

      const prism = await call(ready, `/models/atomic-prism/${MODEL_ID}/load`, {})
      expect(prism.status, await prism.clone().text()).toBe(200)
      const sessions = (await (await call(ready, '/sessions')).json()) as {
        sessions: Array<{ provider: string; model_id: string }>
      }
      expect(sessions.sessions).toEqual([
        expect.objectContaining({ provider: 'atomic-prism', model_id: MODEL_ID }),
      ])
    }, 120_000)

    it('marks a setup a killed core left mid-download interrupted, and resume finishes it', async () => {
      const gguf = bonsai()
      const env = await serveFixtures(gguf, 60_000)
      const first = await core.startDaemon(dataFolder, daemons, [], env)
      await prepare(first.ready)
      const planned = await plan(first.ready)
      const started = (await (
        await call(first.ready, '/model-setups', {
          repo: REPO,
          file: FILE,
          request_id: 'e2e-2',
          plan_digest: planned.digest,
        })
      ).json()) as Setup
      await waitForStage(first.ready, started.setup_id, ['downloading_model'])
      first.child.kill('SIGKILL')
      await new Promise((r) => first.child.once('exit', r))
      core.reapJournalledChildren(dataFolder)

      server.files.set(`/hf/${REPO}/resolve/${REVISION}/${FILE}`, { body: gguf })
      const { ready } = await core.startDaemon(dataFolder, daemons, [], env)
      const recovered = (await (await call(ready, `/model-setups/${started.setup_id}`)).json()) as Setup
      expect(recovered).toMatchObject({ stage: 'interrupted', stopped_at: 'downloading_model' })

      const resumed = await call(ready, `/model-setups/${started.setup_id}/resume`, {})
      expect(resumed.status, await resumed.clone().text()).toBe(200)
      const done = await waitForStage(ready, started.setup_id, ['ready', 'failed', 'cancelled'])
      expect(done, JSON.stringify(done)).toMatchObject({ stage: 'ready' })
    }, 120_000)
  }
)
