/**
 * Stage 5: a compiled app owner must not acknowledge unload before a sidecar finishes loading.
 * Stage 7a: a sidecar load that hangs is cancelled through the same route as llama.cpp's.
 */
import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { APP_BIN, control, reapJournalledChildren, startDaemon } from '../helpers/compiled-core.js'
import type { ReadyLine } from '../helpers/compiled-core.js'
import { foundryLocalTestPlatform } from '../helpers/foundry-local-host.js'

const fake = fileURLToPath(new URL('../helpers/fake-sidecar-server.mjs', import.meta.url))
const daemons: ChildProcess[] = []
const folders: string[] = []
const owners: Array<{ folder: string; ready: ReadyLine }> = []

afterEach(async () => {
  await Promise.all(
    owners.splice(0).map(async ({ folder, ready }) => {
      await control(folder, ready, '/shutdown', { method: 'POST' }).catch(() => {})
    })
  )
  for (const daemon of daemons.splice(0)) daemon.kill('SIGKILL')
  for (const folder of folders) reapJournalledChildren(folder)
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })))
})

async function fixture(kind: 'fm' | 'mlx', mode = 'ready') {
  const folder = await mkdtemp(join(tmpdir(), `atomic-stage5-${kind}-`))
  folders.push(folder)
  const resources = join(folder, 'resources')
  await mkdir(resources, { recursive: true })
  const name = kind === 'fm' ? 'foundation-models-server' : 'mlx-server'
  const argvFile = join(folder, 'spawned.jsonl')
  const pidFile = join(folder, 'spawned.pids')
  const binary = join(resources, name)
  await writeFile(
    binary,
    `#!/bin/sh\nexport FAKE_SIDECAR_KIND=${kind}\nexport FAKE_SIDECAR_MODE=${mode}\nexport FAKE_SIDECAR_DELAY=350\nexport FAKE_SIDECAR_ARGV=${JSON.stringify(argvFile)}\nexport FAKE_SIDECAR_PID_FILE=${JSON.stringify(pidFile)}\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fake)} "$@"\n`
  )
  await chmod(binary, 0o755)
  if (kind === 'mlx') {
    const model = join(folder, 'mlx', 'models', 'e2e-mlx')
    await mkdir(model, { recursive: true })
    await writeFile(join(model, 'model.safetensors'), 'weights')
    await writeFile(join(model, 'config.json'), JSON.stringify({ max_position_embeddings: 8192 }))
    await writeFile(
      join(model, 'model.yml'),
      'model_path: mlx/models/e2e-mlx/model.safetensors\nname: e2e-mlx\nsize_bytes: 7\n'
    )
  }
  const { ready } = await startDaemon(folder, daemons, ['--resources-dir', resources], {}, APP_BIN)
  owners.push({ folder, ready })
  return { folder, ready, argvFile, pidFile }
}

async function waitForFile(path: string) {
  const deadline = Date.now() + 10_000
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`sidecar did not start: ${path}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe.skipIf(process.platform !== 'darwin' || !existsSync(APP_BIN))(
  'stage 5 compiled sidecar owner',
  () => {
    for (const [kind, provider, modelId] of [
      ['fm', 'foundation-models', 'apple/on-device'],
      ['mlx', 'mlx', 'e2e-mlx'],
    ] as const) {
      it(`unloads ${provider} after an overlapping load and releases its model claim`, async () => {
        const { folder, ready, argvFile } = await fixture(kind)
        const route = `/models/${provider}/${modelId}`
        const loading = control(folder, ready, `${route}/load`, { method: 'POST', body: '{}' })
        await waitForFile(argvFile)
        const unloading = control(folder, ready, `${route}/unload`, { method: 'POST' })
        const loaded = await loading
        expect(loaded.status, await loaded.clone().text()).toBe(200)
        const session = (await loaded.json()) as { session: { pid: number } }
        const unloaded = await unloading
        expect(unloaded.status, await unloaded.clone().text()).toBe(200)
        expect(await unloaded.json()).toMatchObject({ success: true })
        const sessions = await control(folder, ready, '/sessions')
        expect((await sessions.json()) as object).toMatchObject({ sessions: [] })
        expect(await readdir(join(folder, 'atomic-core', 'model-claims')).catch(() => [])).toEqual([])
        expect((await readFile(argvFile, 'utf8')).trim()).not.toBe('')
        expect(() => process.kill(session.session.pid, 0)).toThrow()
      })

      it(`cancels a ${provider} load that is hanging: 409 MODEL_LOAD_CANCELLED, the child gone, the claim released`, async () => {
        const { folder, ready, argvFile, pidFile } = await fixture(kind, 'hang')
        const route = `/models/${provider}/${modelId}`
        const loading = control(folder, ready, `${route}/load`, { method: 'POST', body: '{}' })
        await waitForFile(argvFile)
        await waitForFile(pidFile)
        // The pid the fake wrote: a sidecar is journalled only once it is ready, and this one never is.
        const pid = Number((await readFile(pidFile, 'utf8')).trim().split('\n')[0])
        expect(pid).toBeGreaterThan(0)
        expect(() => process.kill(pid, 0)).not.toThrow()
        const journal = async () =>
          (
            JSON.parse(
              await readFile(join(folder, 'atomic-core', 'processes.json'), 'utf8').catch(() => '{}')
            ) as {
              processes?: Array<{ pid: number; provider: string }>
            }
          ).processes ?? []

        const cancel = await control(folder, ready, `${route}/load/cancel`, { method: 'POST' })
        expect(cancel.status, await cancel.clone().text()).toBe(200)
        expect(await cancel.json()).toEqual({ cancelled: true })
        const refused = await loading
        expect(refused.status).toBe(409)
        expect(await refused.json()).toMatchObject({
          error: { code: 'MODEL_LOAD_CANCELLED', message: 'The model load was cancelled.' },
        })
        const gone = Date.now() + 10_000
        while (Date.now() < gone) {
          try {
            process.kill(pid, 0)
            await new Promise((resolve) => setTimeout(resolve, 20))
          } catch {
            break
          }
        }
        expect(() => process.kill(pid, 0)).toThrow()
        expect((await (await control(folder, ready, '/sessions')).json()) as object).toMatchObject({
          sessions: [],
        })
        expect(await journal()).toEqual([])
        expect(await readdir(join(folder, 'atomic-core', 'model-claims')).catch(() => [])).toEqual([])
        // Cancelling again, with nothing loading, is a no-op the app can call freely.
        const again = await control(folder, ready, `${route}/load/cancel`, { method: 'POST' })
        expect(await again.json()).toEqual({ cancelled: false })
      })
    }
  }
)

const FAKE_FOUNDRY_HOST = fileURLToPath(new URL('../helpers/fake-foundry-host.mjs', import.meta.url))
// The compiled core registers Foundry Local only where the platform rule holds; Windows needs a .cmd host.
const FOUNDRY_PLATFORM = process.platform === 'win32' ? null : foundryLocalTestPlatform()

/**
 * A Foundry Local build and a CPU variant on disk, as the engine-builds install and the app's installer
 * leave them, and the host stand-in core starts instead of `foundry-host` (task 6.6).
 */
async function foundryFixture() {
  const folder = await mkdtemp(join(tmpdir(), 'atomic-stage5-foundry-'))
  folders.push(folder)
  const build = join(folder, 'foundry-local', 'backends', 'v2.1.0', FOUNDRY_PLATFORM as string)
  await mkdir(join(build, 'lib'), { recursive: true })
  await writeFile(
    join(build, 'lib', process.platform === 'darwin' ? 'libfoundry_local.dylib' : 'libfoundry_local.so'),
    'lib'
  )
  await writeFile(join(build, '.atomic-owned'), 'atomic-chat\n')
  await writeFile(
    join(build, 'install.json'),
    JSON.stringify({
      tag: 'v2.1.0',
      backendId: FOUNDRY_PLATFORM,
      sha256: null,
      installedAtMs: 1,
      publishedAt: '2026-09-30T00:43:42Z',
      cApiVersion: 2,
    })
  )
  const model = join(folder, 'foundry-local', 'models', 'e2e-fl-cpu')
  await mkdir(model, { recursive: true })
  await writeFile(join(model, 'genai_config.json'), '{}')
  await writeFile(
    join(model, 'model.yml'),
    [
      'model_path: foundry-local/models/e2e-fl-cpu',
      'name: e2e-fl-cpu',
      'size_bytes: 1',
      'foundry_local:',
      '  model_id: qwen2.5-0.5b-instruct',
      '  variant_id: e2e-fl-cpu',
      '  execution_provider: cpu',
      '  device: cpu',
      '',
    ].join('\n')
  )
  const argvFile = join(folder, 'host.jsonl')
  const host = join(folder, 'fake-foundry-host')
  await writeFile(
    host,
    `#!/bin/sh\nexport FAKE_FOUNDRY_ARGV=${JSON.stringify(argvFile)}\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_FOUNDRY_HOST)} "$@"\n`
  )
  await chmod(host, 0o755)
  const { ready } = await startDaemon(
    folder,
    daemons,
    [],
    { ATOMIC_FOUNDRY_HOST_TEST_COMMAND: host },
    APP_BIN
  )
  owners.push({ folder, ready })
  return { folder, ready, argvFile }
}

describe.skipIf(FOUNDRY_PLATFORM === null || !existsSync(APP_BIN))(
  'Foundry Local through the compiled core (task 6.6)',
  () => {
    it('loads a variant in its host, answers on :1337 by the model field, and unloads after the host exited', async () => {
      const { folder, ready, argvFile } = await foundryFixture()
      const loaded = await control(folder, ready, '/models/foundry-local/e2e-fl-cpu/load', {
        method: 'POST',
        body: '{}',
      })
      expect(loaded.status, await loaded.clone().text()).toBe(200)
      const { session } = (await loaded.json()) as { session: { pid: number; port: number; api_key: string } }
      const started = JSON.parse((await readFile(argvFile, 'utf8')).trim().split('\n')[0] as string) as {
        argv: string[]
        ort_telemetry_disabled: string | null
      }
      expect(started.argv[0]).toBe('serve')
      expect(started.ort_telemetry_disabled).toBe('1')
      const hostPort = Number(started.argv[started.argv.indexOf('--port') + 1])
      expect(session.port).not.toBe(hostPort)

      const server = await control(folder, ready, '/server/start', {
        method: 'POST',
        body: JSON.stringify({ port: 0 }),
      })
      const { port } = (await server.json()) as { port: number }
      const answer = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'e2e-fl-cpu', messages: [{ role: 'user', content: 'hi' }] }),
      })
      expect(answer.status, await answer.clone().text()).toBe(200)
      expect(await answer.json()).toMatchObject({
        model: 'e2e-fl-cpu',
        choices: [{ message: { content: 'hi from fake foundry' } }],
      })
      const listed = (await (await fetch(`http://127.0.0.1:${port}/v1/models`)).json()) as {
        data: Array<{ id: string; owned_by: string }>
      }
      expect(listed.data).toContainEqual(
        expect.objectContaining({ id: 'e2e-fl-cpu', owned_by: 'foundry-local' })
      )
      // The host's own port is not the way in: it is the gateway's job, and the gateway wants the key.
      expect((await fetch(`http://127.0.0.1:${session.port}/v1/models`)).status).toBe(401)

      const unloaded = await control(folder, ready, '/models/foundry-local/e2e-fl-cpu/unload', {
        method: 'POST',
      })
      expect(await unloaded.json()).toMatchObject({ success: true })
      expect(() => process.kill(session.pid, 0)).toThrow()
      expect((await (await control(folder, ready, '/sessions')).json()) as object).toMatchObject({
        sessions: [],
      })
    })
  }
)
