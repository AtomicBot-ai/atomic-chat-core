/** Stage 5: a compiled app owner must not acknowledge unload before a sidecar finishes loading. */
import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { APP_BIN, control, reapJournalledChildren, startDaemon } from '../helpers/compiled-core.js'
import type { ReadyLine } from '../helpers/compiled-core.js'

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

async function fixture(kind: 'fm' | 'mlx') {
  const folder = await mkdtemp(join(tmpdir(), `atomic-stage5-${kind}-`))
  folders.push(folder)
  const resources = join(folder, 'resources')
  await mkdir(resources, { recursive: true })
  const name = kind === 'fm' ? 'foundation-models-server' : 'mlx-server'
  const argvFile = join(folder, 'spawned.jsonl')
  const binary = join(resources, name)
  await writeFile(
    binary,
    `#!/bin/sh\nexport FAKE_SIDECAR_KIND=${kind}\nexport FAKE_SIDECAR_DELAY=350\nexport FAKE_SIDECAR_ARGV=${JSON.stringify(argvFile)}\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fake)} "$@"\n`
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
  return { folder, ready, argvFile }
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
    }
  }
)
