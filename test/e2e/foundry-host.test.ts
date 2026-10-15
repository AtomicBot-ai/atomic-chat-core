/**
 * The `foundry-host` mode of the compiled binaries against a real Foundry Local build (openspec change
 * `add-foundry-local`, task 5.1). Skipped unless FOUNDRY_LOCAL_TEST_LIB names an unpacked release
 * archive for this platform (the folder holding `lib/`), e.g. foundry-local-osx-arm64.tgz of v2.1.0.
 *
 * No imports from `src/`.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { createInterface } from 'node:readline'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { APP_BIN, BIN } from '../helpers/compiled-core.js'

const LIB = process.env['FOUNDRY_LOCAL_TEST_LIB']
/** A CPU variant folder (e.g. qwen2.5-0.5b-instruct-generic-cpu, downloaded as the app's installer would). */
const MODEL = process.env['FOUNDRY_LOCAL_TEST_MODEL']
let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atomic-foundry-host-e2e-'))
})
afterEach(() => rm(dir, { recursive: true, force: true }))

describe.skipIf(!LIB || !existsSync(BIN))('foundry-host against a real Foundry Local library', () => {
  it.each([
    ['atomic-chat-core', BIN],
    ['atomic-chat-app-core', APP_BIN],
  ])('%s foundry-host probe loads the library, checks its C API and lists its accelerators', (_name, bin) => {
    const appData = join(dir, 'runtime')
    const run = spawnSync(
      bin,
      ['foundry-host', 'probe', '--lib', LIB as string, '--app-data', appData, '--logs', join(dir, 'logs')],
      { encoding: 'utf8', timeout: 60_000 }
    )
    expect(run.status, run.stderr).toBe(0)
    const answer = JSON.parse(run.stdout.trim().split('\n').at(-1) as string) as {
      c_api_version: number
      accelerators: Array<{ name: string; device: string; prepared: boolean }>
    }
    expect(answer.c_api_version).toBe(2)
    expect(Array.isArray(answer.accelerators)).toBe(true)
    for (const accelerator of answer.accelerators)
      expect(accelerator).toEqual({
        name: expect.any(String),
        device: expect.any(String),
        execution_provider: expect.anything(),
        prepared: false,
      })
  })

  it('keeps the library to the data folders core gives it', async () => {
    spawnSync(
      BIN,
      [
        'foundry-host',
        'probe',
        '--lib',
        LIB as string,
        '--app-data',
        join(dir, 'runtime'),
        '--logs',
        join(dir, 'logs'),
      ],
      {
        encoding: 'utf8',
        timeout: 60_000,
      }
    )
    expect((await readdir(dir)).sort()).toEqual(expect.arrayContaining(['logs']))
    expect((await readdir(dir)).every((name) => ['logs', 'runtime'].includes(name))).toBe(true)
  })

  it('refuses a folder that holds no Foundry Local library, naming it', () => {
    const run = spawnSync(
      BIN,
      ['foundry-host', 'probe', '--lib', dir, '--app-data', join(dir, 'r'), '--logs', join(dir, 'l')],
      {
        encoding: 'utf8',
        timeout: 60_000,
      }
    )
    expect(run.status).not.toBe(0)
    expect(run.stderr).toMatch(/foundry_local/)
  })
})

const freePort = () =>
  new Promise<number>((resolve) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })

describe.skipIf(!LIB || !MODEL || !existsSync(BIN))('foundry-host serve with a real CPU model', () => {
  it('serves the model under /catalogs/local on loopback, and stops on stdin close leaving no cache', async () => {
    const port = await freePort()
    const cache = join(dir, 'tmp', 's1')
    const host = spawn(
      BIN,
      [
        'foundry-host',
        'serve',
        '--lib',
        LIB as string,
        '--app-data',
        join(dir, 'runtime'),
        '--logs',
        join(dir, 'logs'),
        '--model',
        MODEL as string,
        '--ep',
        'cpu',
        '--port',
        String(port),
        '--cache',
        cache,
        '--id',
        'atomic-e2e-cpu:1',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    )
    const ready = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const lines = createInterface({ input: host.stdout })
      lines.on('line', (line) => {
        if (line.startsWith('{') && line.includes('"ready"'))
          resolve(JSON.parse(line) as Record<string, unknown>)
      })
      host.once('exit', (code) => reject(new Error(`host exited ${String(code)} before ready`)))
    })
    expect(ready).toMatchObject({
      ready: true,
      url: `http://127.0.0.1:${port}`,
      base_path: '/catalogs/local',
      model_id: 'atomic-e2e-cpu:1',
    })
    const response = await fetch(`http://127.0.0.1:${port}/catalogs/local/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'atomic-e2e-cpu:1',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'Say hello.' }],
      }),
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { choices: Array<{ message: { content: string } }> }
    expect(body.choices[0]?.message.content.length).toBeGreaterThan(0)
    const exited = new Promise<number | null>((resolve) => host.once('exit', (code) => resolve(code)))
    host.stdin.end()
    expect(await exited).toBe(0)
    expect(existsSync(cache)).toBe(false)
  }, 120_000)

  it.skipIf(process.platform === 'win32')(
    'stops on SIGTERM while core still holds its stdin open, as core unloads a model',
    async () => {
      const port = await freePort()
      const cache = join(dir, 'tmp', 's2')
      const host = spawn(
        BIN,
        [
          'foundry-host',
          'serve',
          '--lib',
          LIB as string,
          '--app-data',
          join(dir, 'runtime'),
          '--logs',
          join(dir, 'logs'),
          '--model',
          MODEL as string,
          '--ep',
          'cpu',
          '--port',
          String(port),
          '--cache',
          cache,
          '--id',
          'atomic-e2e-cpu:1',
        ],
        { stdio: ['pipe', 'pipe', 'pipe'] }
      )
      await new Promise<void>((resolve, reject) => {
        createInterface({ input: host.stdout }).on('line', (line) => {
          if (line.includes('"ready"')) resolve()
        })
        host.once('exit', (code) => reject(new Error(`host exited ${String(code)} before ready`)))
      })
      const exited = new Promise<number | null>((resolve) => host.once('exit', (code) => resolve(code)))
      host.kill('SIGTERM')
      const code = await Promise.race([
        exited,
        new Promise<string>((resolve) => setTimeout(() => resolve('still running'), 10_000)),
      ])
      if (code === 'still running') host.kill('SIGKILL')
      expect(code).toBe(0)
      expect(existsSync(cache)).toBe(false)
    },
    60_000
  )
})
