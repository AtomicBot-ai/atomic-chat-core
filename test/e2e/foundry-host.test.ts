/**
 * The `foundry-host` mode of the compiled binaries against a real Foundry Local build (openspec change
 * `add-foundry-local`, task 5.1). Skipped unless FOUNDRY_LOCAL_TEST_LIB names an unpacked release
 * archive for this platform (the folder holding `lib/`), e.g. foundry-local-osx-arm64.tgz of v2.1.0.
 *
 * No imports from `src/`.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { createInterface } from 'node:readline'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { APP_BIN, BIN } from '../helpers/compiled-core.js'

const LIB = process.env['FOUNDRY_LOCAL_TEST_LIB']
const EXPECTED_VERSION = process.env['FOUNDRY_LOCAL_TEST_VERSION'] ?? '2.1.0'
const EXPECTED_API = EXPECTED_VERSION === '2.1.0' ? 2 : 3
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
      version: string
      accelerators: Array<{ name: string; device: string; prepared: boolean }>
    }
    expect(answer.c_api_version).toBe(EXPECTED_API)
    expect(answer.version).toMatch(new RegExp(`^v?${EXPECTED_VERSION.replaceAll('.', '\\.')}(?:$|[+\\s-])`))
    expect(Array.isArray(answer.accelerators)).toBe(true)
    for (const accelerator of answer.accelerators)
      expect(accelerator).toEqual({
        name: expect.any(String),
        device: expect.any(String),
        execution_provider: expect.anything(),
        prepared: false,
      })
  })

  it.each([
    ['atomic-chat-core', BIN],
    ['atomic-chat-app-core', APP_BIN],
  ])('%s rejects a real library whose bundled native dependencies are missing', async (_name, bin) => {
    const library =
      process.platform === 'darwin'
        ? 'libfoundry_local.dylib'
        : process.platform === 'win32'
          ? 'foundry_local.dll'
          : 'libfoundry_local.so'
    const isolated = join(dir, 'incomplete')
    await mkdir(join(isolated, 'lib'), { recursive: true })
    await copyFile(join(LIB!, 'lib', library), join(isolated, 'lib', library))
    const run = spawnSync(
      bin,
      [
        'foundry-host',
        'probe',
        '--lib',
        isolated,
        '--app-data',
        join(dir, 'runtime'),
        '--logs',
        join(dir, 'logs'),
      ],
      { encoding: 'utf8', timeout: 60_000 }
    )
    expect(run.status, run.stderr).toBe(3)
    expect(run.stderr).toMatch(/onnxruntime|not found|could not|cannot|126/i)
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

// Both binaries run the mode through the package's public entry (change close-cli-core-gaps, task 1.2),
// so the FFI module must be inside each of them: without it the load fails with "only inside a
// compiled binary" instead of reaching the folder. No real library needed.
describe.skipIf(!existsSync(BIN) || !existsSync(APP_BIN))('foundry-host through the public entry', () => {
  it.each([
    ['atomic-chat-core', BIN],
    ['atomic-chat-app-core', APP_BIN],
  ])(
    '%s reaches the folder through its bundled FFI module, and answers a wrong mode with usage',
    (_name, bin) => {
      const empty = spawnSync(
        bin,
        ['foundry-host', 'probe', '--lib', dir, '--app-data', join(dir, 'r'), '--logs', join(dir, 'l')],
        { encoding: 'utf8', timeout: 60_000 }
      )
      expect(empty.status, empty.stderr).toBe(3)
      expect(empty.stderr).toMatch(/^foundry_local does not load from /)
      expect(empty.stderr).not.toMatch(/only inside a compiled binary/)
      expect(empty.stdout).toBe('')
      const usage = spawnSync(bin, ['foundry-host', 'nope'], { encoding: 'utf8', timeout: 60_000 })
      expect(usage.status).toBe(2)
      expect(usage.stderr).toBe('foundry-host: unknown mode "nope" (probe, prepare, serve)\n')
    }
  )
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

const NPU_MODEL = process.env['FOUNDRY_LOCAL_TEST_NPU_MODEL']

describe.skipIf(
  process.platform !== 'win32' || !LIB || !NPU_MODEL || !existsSync(BIN) || !existsSync(APP_BIN)
)('foundry-host with the bundled Intel OpenVINO EP', () => {
  it('reports a missing Intel bundle without breaking the native CPU probe', async () => {
    const incomplete = join(dir, 'without-intel')
    await mkdir(join(incomplete, 'lib'), { recursive: true })
    for (const entry of await readdir(join(LIB!, 'lib'), { withFileTypes: true }))
      if (entry.isFile()) await copyFile(join(LIB!, 'lib', entry.name), join(incomplete, 'lib', entry.name))
    const common = ['--lib', incomplete, '--app-data', join(dir, 'runtime'), '--logs', join(dir, 'logs')]
    const prepared = spawnSync(BIN, ['foundry-host', 'prepare', ...common, 'OpenVINOExecutionProvider'], {
      encoding: 'utf8',
      timeout: 60_000,
    })
    expect(prepared.status, prepared.stderr).toBe(0)
    expect(JSON.parse(prepared.stdout.trim().split('\n').at(-1)!)).toMatchObject({
      done: true,
      accelerators: [
        {
          name: 'OpenVINOExecutionProvider',
          prepared: false,
          reason: expect.stringContaining('missing the bundled Intel OpenVINO 1.8.1'),
        },
      ],
    })
    const probe = spawnSync(BIN, ['foundry-host', 'probe', ...common], { encoding: 'utf8', timeout: 60_000 })
    expect(probe.status, probe.stderr).toBe(0)
    expect(JSON.parse(probe.stdout.trim().split('\n').at(-1)!)).toMatchObject({
      version: '2.4.0',
      c_api_version: 3,
    })
  }, 120_000)

  it.each([
    ['atomic-chat-core', BIN],
    ['atomic-chat-app-core', APP_BIN],
  ])(
    '%s prepares the pinned EP and generates on an explicitly NPU-only model',
    async (_name, bin) => {
      const config = JSON.parse(await readFile(join(NPU_MODEL!, 'genai_config.json'), 'utf8')) as {
        model: {
          context_length: number
          decoder: { session_options: { provider_options: Array<{ OpenVINO?: { device_type: string } }> } }
        }
      }
      expect(config.model.decoder.session_options.provider_options).toContainEqual(
        expect.objectContaining({ OpenVINO: expect.objectContaining({ device_type: 'NPU' }) })
      )
      const appData = join(dir, 'runtime')
      const logs = join(dir, 'logs')
      const prepared = spawnSync(
        bin,
        [
          'foundry-host',
          'prepare',
          '--lib',
          LIB!,
          '--app-data',
          appData,
          '--logs',
          logs,
          'OpenVINOExecutionProvider',
        ],
        { encoding: 'utf8', timeout: 60_000 }
      )
      expect(prepared.status, prepared.stderr).toBe(0)
      expect(JSON.parse(prepared.stdout.trim().split('\n').at(-1)!)).toMatchObject({
        done: true,
        accelerators: [{ name: 'OpenVINOExecutionProvider', prepared: true }],
      })
      const port = await freePort()
      const cache = join(dir, 'npu-catalog')
      const host = spawn(
        bin,
        [
          'foundry-host',
          'serve',
          '--lib',
          LIB!,
          '--app-data',
          appData,
          '--logs',
          logs,
          '--model',
          NPU_MODEL!,
          '--ep',
          'openvino',
          '--port',
          String(port),
          '--cache',
          cache,
          '--id',
          'atomic-e2e-npu:1',
          '--context-length',
          String(config.model.context_length),
        ],
        { stdio: ['pipe', 'pipe', 'pipe'] }
      )
      let stderr = ''
      host.stderr.on('data', (chunk) => {
        stderr += String(chunk)
      })
      const exited = new Promise<number | null>((resolve) => host.once('exit', resolve))
      try {
        const ready = await new Promise<Record<string, unknown>>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`NPU readiness timed out: ${stderr}`)), 120_000)
          createInterface({ input: host.stdout }).on('line', (line) => {
            if (line.includes('"ready":true')) {
              clearTimeout(timer)
              resolve(JSON.parse(line) as Record<string, unknown>)
            }
          })
          host.once('exit', (code) => {
            clearTimeout(timer)
            reject(new Error(`NPU host exited ${String(code)}: ${stderr}`))
          })
          host.once('error', (error) => {
            clearTimeout(timer)
            reject(error)
          })
        })
        expect(ready).toMatchObject({ ready: true, execution_provider: 'OpenVINOExecutionProvider' })
        const response = await fetch(`http://127.0.0.1:${port}/catalogs/local/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'atomic-e2e-npu:1',
            max_tokens: 12,
            messages: [{ role: 'user', content: 'Say hello.' }],
          }),
          signal: AbortSignal.timeout(60_000),
        })
        const answer = await response.text()
        expect(response.status, answer).toBe(200)
        expect(
          (
            JSON.parse(answer) as { choices: Array<{ message: { content: string } }> }
          ).choices[0]?.message.content.trim()
        ).toBeTruthy()
      } finally {
        host.stdin.end()
        const killTimer = setTimeout(() => host.kill(), 10_000)
        try {
          expect(await exited, stderr).toBe(0)
        } finally {
          clearTimeout(killTimer)
        }
      }
      expect(existsSync(cache)).toBe(false)
    },
    240_000
  )
})

const WEBGPU_MODEL = process.env['FOUNDRY_LOCAL_TEST_WEBGPU_MODEL']

describe.skipIf(
  process.platform !== 'darwin' ||
    EXPECTED_VERSION !== '2.4.0' ||
    !LIB ||
    !WEBGPU_MODEL ||
    !existsSync(BIN) ||
    !existsSync(APP_BIN)
)('foundry-host Mac WebGPU preparation', () => {
  it('refuses an unprepared WebGPU model without downloading on serve', async () => {
    const runtime = join(dir, 'runtime')
    const run = spawnSync(
      BIN,
      [
        'foundry-host',
        'serve',
        '--lib',
        LIB!,
        '--app-data',
        runtime,
        '--logs',
        join(dir, 'logs'),
        '--model',
        WEBGPU_MODEL!,
        '--ep',
        'webgpu',
        '--port',
        String(await freePort()),
        '--cache',
        join(dir, 'catalog'),
        '--id',
        'atomic-e2e-webgpu:1',
        '--context-length',
        '4096',
      ],
      { encoding: 'utf8', timeout: 30_000 }
    )
    expect(run.status, run.stderr).toBe(4)
    expect(run.stderr).toMatch(/Prepare the WebGPU accelerator again/)
    expect(existsSync(join(runtime, 'v2.4.0', 'macos-arm64', 'webgpu-ep'))).toBe(false)
  }, 45_000)

  it('app-core prepares WebGPU, then a fresh host generates using its verified cache', async () => {
    const runtime = join(dir, 'runtime'),
      logs = join(dir, 'logs'),
      cache = join(dir, 'catalog')
    const prepare = spawnSync(
      APP_BIN,
      [
        'foundry-host',
        'prepare',
        '--lib',
        LIB!,
        '--app-data',
        runtime,
        '--logs',
        logs,
        'WebGpuExecutionProvider',
      ],
      { encoding: 'utf8', timeout: 90_000 }
    )
    expect(prepare.status, prepare.stderr).toBe(0)
    expect(JSON.parse(prepare.stdout.trim().split('\n').at(-1)!)).toMatchObject({
      done: true,
      accelerators: [{ name: 'WebGpuExecutionProvider', prepared: true }],
    })
    const port = await freePort()
    const host = spawn(
      APP_BIN,
      [
        'foundry-host',
        'serve',
        '--lib',
        LIB!,
        '--app-data',
        runtime,
        '--logs',
        logs,
        '--model',
        WEBGPU_MODEL!,
        '--ep',
        'webgpu',
        '--port',
        String(port),
        '--cache',
        cache,
        '--id',
        'atomic-e2e-webgpu:1',
        '--context-length',
        '4096',
        '--tools',
        '--reasoning-start',
        '<think>',
        '--reasoning-end',
        '</think>',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    )
    let stderr = ''
    host.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    const exited = new Promise<number | null>((resolve) => host.once('close', resolve))
    try {
      const ready = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`WebGPU readiness timeout: ${stderr}`)), 120_000)
        createInterface({ input: host.stdout }).on('line', (line) => {
          if (line.includes('"ready":true')) {
            clearTimeout(timer)
            resolve(JSON.parse(line) as Record<string, unknown>)
          }
        })
        host.once('exit', (code) => {
          clearTimeout(timer)
          reject(new Error(`WebGPU host exited ${String(code)}: ${stderr}`))
        })
        host.once('error', (error) => {
          clearTimeout(timer)
          reject(error)
        })
      })
      expect(ready).toMatchObject({ ready: true, execution_provider: 'WebGPUExecutionProvider' })
      const response = await fetch(`http://127.0.0.1:${port}/catalogs/local/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'atomic-e2e-webgpu:1',
          max_tokens: 128,
          messages: [{ role: 'user', content: 'Say hello in one short sentence.' }],
        }),
        signal: AbortSignal.timeout(90_000),
      })
      const text = await response.text()
      expect(response.status, text).toBe(200)
      expect(
        (
          JSON.parse(text) as { choices: Array<{ message: { content: string } }> }
        ).choices[0]?.message.content.trim()
      ).toBeTruthy()
    } finally {
      host.stdin.end()
      const kill = setTimeout(() => host.kill(), 10_000)
      try {
        expect(await exited, stderr).toBe(0)
      } finally {
        clearTimeout(kill)
      }
    }
    expect(existsSync(cache)).toBe(false)
  }, 240_000)
})
