/**
 * The shared managed-text load lifecycle against two fake engines with different readiness paths,
 * log markers, timeouts and exit classifiers — nothing in the lifecycle may care which one it runs —
 * and an in-process fake `docker` (`test/helpers/fake-docker-exec.ts`). Time is a fake clock the
 * injected `sleep` advances, so a three-minute start takes milliseconds.
 */
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../../contracts/index.js'
import type { CoreEvents } from '../../contracts/index.js'
import { ExecutionJournal, startHeartbeatTicker } from '../container/index.js'
import type { HeartbeatTicker, HeartbeatTickerOptions } from '../container/index.js'
import { makeTmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import { FakeDocker } from '../../../test/helpers/fake-docker-exec.js'
import { MANAGED_TEXT_ADAPTER_CONTRACT_VERSION, ManagedTextAdapterRegistry } from './adapter.js'
import type { ManagedTextAdapter } from './adapter.js'
import { createDesktopManagedDeployment } from './deployment.js'
import { startManagedGateway } from './gateway.js'
import type { ManagedGatewayOptions } from './gateway.js'
import { ManagedLoadError, ManagedTextLifecycle } from './lifecycle.js'
import type { ManagedLoadRequest, ManagedTextLifecycleDeps } from './lifecycle.js'
import type { ManagedDeployment } from './types.js'

const GiB = 1024 ** 3
const DIGEST = `sha256:${'b'.repeat(64)}` as const
const GPU = 'GPU-11111111-2222-3333-4444-555555555555'
const capabilities = {
  tools: false,
  reasoning: false,
  structured_output: false,
  vision: false,
  embeddings: false,
  responses: false,
}

/** Engine one: `/health`, no log markers, base + per-GiB timeout, reads CUDA OOM numbers out of its log. */
const alpha: ManagedTextAdapter<{ ctx: number }> = {
  id: 'alpha-engine',
  contractVersion: MANAGED_TEXT_ADAPTER_CONTRACT_VERSION,
  readiness: { path: '/health', expectedStatus: 200 },
  routes: [{ method: 'GET', path: '/v1/models' }],
  stageMarkers: [],
  validateSettings: (raw) => {
    const ctx = (raw as { ctx?: unknown } | undefined)?.ctx ?? 4096
    if (typeof ctx !== 'number') throw new AtomicCoreError('INVALID_ARGUMENT', 'ctx must be a number')
    return { ctx }
  },
  buildLaunch: (c) => ({
    engine: { container_port: 8000 },
    argv: ['alpha-serve', c.modelPath, '--cache', c.engineCachePath, '--ctx', String(c.settings.ctx)],
    env: { ALPHA_MODE: 'fast' },
  }),
  readinessTimeoutMs: (weightBytes) => 30_000 + (weightBytes / GiB) * 10_000,
  classifyExit: (tail, exitCode) => {
    const oom = /CUDA out of memory\. Tried to allocate ([\d.]+) GiB/.exec(tail)
    if (oom) {
      return {
        kind: 'out-of-memory',
        message: `The GPU ran out of memory (tried to allocate ${oom[1]} GiB).`,
        numbers: { requested_gib: Number(oom[1]) },
        excerpt: oom[0],
      }
    }
    return { kind: 'other', message: `alpha exited with ${String(exitCode)}` }
  },
  capabilities: () => capabilities,
}

/** Engine two: `/v1/models`, a log marker for initializing-engine, a flat five-minute timeout. */
const beta: ManagedTextAdapter<Record<string, never>> = {
  id: 'beta-engine',
  contractVersion: MANAGED_TEXT_ADAPTER_CONTRACT_VERSION,
  readiness: { path: '/v1/models', expectedStatus: 200 },
  routes: [{ method: 'GET', path: '/v1/models' }],
  stageMarkers: [{ stage: 'initializing-engine', pattern: /Loading checkpoint shards/ }],
  validateSettings: () => ({}),
  buildLaunch: () => ({ engine: { container_port: 9000 }, argv: ['beta', 'serve'] }),
  readinessTimeoutMs: () => 5 * 60_000,
  classifyExit: (tail) =>
    /unsupported architecture/.test(tail)
      ? { kind: 'unsupported-model', message: 'beta cannot run this architecture.' }
      : { kind: 'other', message: 'beta exited' },
  capabilities: () => capabilities,
}

/** Engine three: exists only to prove `rewriteRequestBody` is invoked *through* the adapter object,
 *  not a detached reference to the function (findings-2.13-r2.md item 4) — its `rewriteRequestBody`
 *  is a real object method that reads `this.id`, which throws if ever called with `this` unbound. */
const gamma: ManagedTextAdapter<{ tag: string }> = {
  id: 'gamma-rewrite-engine',
  contractVersion: MANAGED_TEXT_ADAPTER_CONTRACT_VERSION,
  readiness: { path: '/health', expectedStatus: 200 },
  routes: [
    { method: 'GET', path: '/v1/models' },
    { method: 'POST', path: '/v1/chat/completions' },
  ],
  rewritableRoutes: [{ method: 'POST', path: '/v1/chat/completions' }],
  stageMarkers: [],
  validateSettings: (raw) => ({ tag: (raw as { tag?: string } | undefined)?.tag ?? 'default' }),
  buildLaunch: () => ({ engine: { container_port: 8000 }, argv: ['gamma'] }),
  readinessTimeoutMs: () => 10_000,
  classifyExit: () => ({ kind: 'other', message: 'gamma exited' }),
  capabilities: () => capabilities,
  rewriteRequestBody(route, body, settings) {
    return { route, adapterId: this.id, settingsTag: settings.tag, body }
  },
}

type Emitted = { name: keyof CoreEvents; payload: unknown }

let data: TmpDataFolder
let docker: FakeDocker
let clock: number
let emitted: Emitted[]
let journal: ExecutionJournal
let lifecycle: ManagedTextLifecycle
let tickers: Array<{ stopped: boolean }>
let readyAt: number | null
let onProbe: ((now: number) => void) | undefined
let probed: string[]
let allowedHosts: string[]
let modelDir: string

async function build(
  over: Partial<ManagedTextLifecycleDeps> = {},
  extraAdapters: ManagedTextAdapter[] = []
): Promise<ManagedTextLifecycle> {
  const adapters = new ManagedTextAdapterRegistry()
  adapters.register(alpha)
  adapters.register(beta)
  for (const adapter of extraAdapters) adapters.register(adapter)
  let port = 41_000
  let generation = 0
  const fakeFetch = (async (url: string | URL | Request) => {
    const href = String(url)
    probed.push(href)
    onProbe?.(clock)
    return new Response('', { status: readyAt !== null && clock >= readyAt ? 200 : 503 })
  }) as typeof fetch
  lifecycle = new ManagedTextLifecycle({
    provider: 'llamacpp-upstream',
    adapters,
    exec: docker.exec,
    deployment: createDesktopManagedDeployment({ allocateHostPort: async () => port++ }),
    journal,
    paths: data.layout.managed,
    instanceId: 'core-1',
    scope: 'app',
    allowedHosts,
    selinuxDataRoot: data.root,
    emit: (name, payload) => emitted.push({ name, payload }),
    fetch: fakeFetch,
    now: () => clock,
    sleep: async (ms, signal) => {
      if (signal?.aborted) throw signal.reason
      clock += ms
      await new Promise((resolve) => setImmediate(resolve))
      if (signal?.aborted) throw signal.reason
    },
    newGeneration: () => `gen-${++generation}`,
    startHeartbeat: (options: HeartbeatTickerOptions): HeartbeatTicker => {
      const ticker = startHeartbeatTicker({ ...options, intervalMs: 60_000 })
      const record = { stopped: false }
      tickers.push(record)
      return {
        ready: ticker.ready,
        stop: () => {
          record.stopped = true
          ticker.stop()
        },
      }
    },
    timings: { pollIntervalMs: 1_000, monitorIntervalMs: 1_000, heartbeatReadyTimeoutMs: 2_000 },
    ...over,
  })
  return lifecycle
}

function request_(over: Partial<ManagedLoadRequest> = {}): ManagedLoadRequest {
  return {
    modelId: 'org/model-a',
    modelPath: modelDir,
    weightBytes: 2 * GiB,
    installation: {
      descriptor_id: 'engine-1.0-r1',
      engine_id: 'alpha',
      adapter_id: 'alpha-engine',
      adapter_contract_version: MANAGED_TEXT_ADAPTER_CONTRACT_VERSION,
      image: { repository: 'registry.example/alpha', digest: DIGEST },
    },
    family: null,
    gpuUuid: GPU,
    selinux: false,
    settings: {},
    ...over,
  }
}

const betaInstallation = {
  descriptor_id: 'beta-2.0-r1',
  engine_id: 'beta',
  adapter_id: 'beta-engine',
  adapter_contract_version: MANAGED_TEXT_ADAPTER_CONTRACT_VERSION,
  image: { repository: 'registry.example/beta', digest: DIGEST },
}

function progress(): CoreEvents['session:load-progress'][] {
  return emitted
    .filter((e) => e.name === 'session:load-progress')
    .map((e) => e.payload as CoreEvents['session:load-progress'])
}

/** `createContainer` mounts real paths (`/var` is `/private/var` on macOS), so expectations do too. */
const real = (path: string) => realpathSync(path)

async function rejection(promise: Promise<unknown>): Promise<AtomicCoreError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof AtomicCoreError) return error
    throw error
  }
  throw new Error('expected a rejection')
}

/** A raw GET to the gateway, with a Host header fetch would not let us set. */
function gatewayGet(port: number, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/v1/models', method: 'GET', headers }, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    req.on('error', reject)
    req.end()
  })
}

beforeEach(async () => {
  data = await makeTmpDataFolder('managed-lifecycle-')
  modelDir = join(data.root, 'fake-engine', 'models', 'model-a')
  await mkdir(modelDir, { recursive: true })
  await writeFile(join(modelDir, 'config.json'), '{}')
  docker = new FakeDocker()
  clock = 0
  emitted = []
  tickers = []
  readyAt = 0
  onProbe = undefined
  probed = []
  allowedHosts = []
  journal = await ExecutionJournal.open(data.layout)
})

afterEach(async () => {
  await lifecycle?.shutdown()
  await data.cleanup()
})

describe('ManagedTextLifecycle: stages and timeout', () => {
  it('a long start does not fail before the timeout, and reports initializing-engine with growing elapsed time', async () => {
    await build()
    readyAt = 180_000 // three minutes; alpha's timeout for 30 GiB is 330 s
    const info = await lifecycle.load(request_({ weightBytes: 30 * GiB }))
    expect(info).toMatchObject({
      pid: null,
      execution: 'container',
      generation: 'gen-1',
      model_id: 'org/model-a',
    })

    const stages = progress()
    expect(stages[0]).toMatchObject({
      stage: 'starting-container',
      provider: 'llamacpp-upstream',
      generation: 'gen-1',
    })
    const initializing = stages.filter((p) => p.stage === 'initializing-engine')
    expect(initializing.length).toBeGreaterThan(100)
    const elapsed = initializing.map((p) => p.elapsed_ms)
    expect(elapsed).toEqual([...elapsed].sort((a, b) => a - b))
    expect(elapsed[elapsed.length - 1]).toBeGreaterThanOrEqual(179_000)
    expect(stages[stages.length - 1]).toMatchObject({ stage: 'ready' })
    expect(probed.every((url) => url === 'http://127.0.0.1:41000/health')).toBe(true)
  })

  it('fails with MODEL_LOAD_TIMED_OUT at the adapter timeout, and a setting overrides it', async () => {
    await build()
    readyAt = null
    const timedOut = await rejection(lifecycle.load(request_({ weightBytes: 0 })))
    expect(timedOut.code).toBe('MODEL_LOAD_TIMED_OUT')
    expect(clock).toBeGreaterThanOrEqual(30_000)
    expect(clock).toBeLessThan(33_000)

    clock = 0
    const overridden = await rejection(lifecycle.load(request_({ weightBytes: 0, timeoutMs: 5_000 })))
    expect(overridden.code).toBe('MODEL_LOAD_TIMED_OUT')
    expect(clock).toBeLessThan(8_000)
    expect(docker.containers.size).toBe(0)
    expect(journal.list()).toEqual([])
  })

  it("stays in starting-container until the adapter's log marker shows up, for an engine that has markers", async () => {
    await build()
    readyAt = 20_000
    onProbe = (now) => {
      if (now === 8_000) docker.log(docker.last().id, 'Loading checkpoint shards: 1/4')
    }
    await lifecycle.load(request_({ installation: betaInstallation }))
    const stages = progress().map((p) => [p.stage, p.elapsed_ms] as const)
    const firstInit = stages.find(([stage]) => stage === 'initializing-engine')
    expect(firstInit?.[1]).toBeGreaterThanOrEqual(8_000)
    expect(
      stages.filter(([s, t]) => s === 'starting-container' && t > 0 && t < 8_000).length
    ).toBeGreaterThan(3)
    expect(probed.every((url) => url.endsWith('/v1/models'))).toBe(true)
  })

  it('runs the stopping-previous callback first, before any container exists', async () => {
    await build()
    const order: string[] = []
    await lifecycle.load(
      request_({
        stopPrevious: async () => {
          order.push(`stop-previous with ${docker.containers.size} containers`)
        },
      })
    )
    expect(order).toEqual(['stop-previous with 0 containers'])
    expect(progress().map((p) => p.stage)[0]).toBe('stopping-previous')
  })

  it('runs beforeCreate after stopPrevious and before docker create (task 2.16w round 1, finding 1)', async () => {
    await build()
    const order: string[] = []
    await lifecycle.load(
      request_({
        stopPrevious: async () => {
          order.push('stop-previous')
        },
        beforeCreate: async () => {
          order.push(`before-create with ${docker.containers.size} containers`)
        },
      })
    )
    expect(order).toEqual(['stop-previous', 'before-create with 0 containers'])
  })

  it('a beforeCreate that throws refuses the load with no container ever created', async () => {
    await build()
    const error = await rejection(
      lifecycle.load(
        request_({
          beforeCreate: async () => {
            throw new AtomicCoreError('MODEL_INCOMPATIBLE', 'not enough free memory on the chosen card')
          },
        })
      )
    )
    expect(error.code).toBe('MODEL_INCOMPATIBLE')
    expect(docker.containers.size).toBe(0)
    expect(docker.calls).toEqual([])
  })

  it('beforeCreate runs once even when the first docker start attempt loses the port-bind race and retries', async () => {
    await build()
    docker.startFailures = [
      'Error response from daemon: Bind for 127.0.0.1:41000 failed: port is already allocated',
    ]
    let calls = 0
    await lifecycle.load(
      request_({
        beforeCreate: async () => {
          calls += 1
        },
      })
    )
    expect(calls).toBe(1)
    expect(docker.containers.size).toBe(1)
  })
})

describe('ManagedTextLifecycle: early exit', () => {
  it('a container exit fails within seconds with the classification, its numbers and the log tail', async () => {
    await build()
    readyAt = null
    let exitedAt = -1
    onProbe = (now) => {
      if (now === 20_000) {
        exitedAt = now
        docker.exit(docker.last().id, 1, [
          'loading weights',
          'CUDA out of memory. Tried to allocate 2.00 GiB',
        ])
      }
    }
    const error = await rejection(lifecycle.load(request_({ weightBytes: 30 * GiB })))
    expect(error).toBeInstanceOf(ManagedLoadError)
    expect(error.code).toBe('OUT_OF_MEMORY')
    expect(error.message).toContain('2.00 GiB')
    expect(error.details).toBe('loading weights\nCUDA out of memory. Tried to allocate 2.00 GiB\n')
    expect((error as ManagedLoadError).classification?.numbers).toEqual({ requested_gib: 2 })
    expect(clock - exitedAt).toBeLessThanOrEqual(2_000)
    expect(docker.containers.size).toBe(0)
    expect(journal.list()).toEqual([])
  })

  it('classifies from the whole log: an OOM line above a traceback longer than the tail is still OUT_OF_MEMORY, with the line in details', async () => {
    await build()
    readyAt = null
    const traceback = Array.from({ length: 400 }, (_, i) => `  File "worker.py", line ${i}, in worker_main`)
    onProbe = (now) => {
      if (now === 5_000) {
        docker.exit(docker.last().id, 1, [
          'loading weights',
          'CUDA out of memory. Tried to allocate 0.05 GiB',
          'Traceback (most recent call last):',
          ...traceback,
          'RuntimeError: Executor worker returned error',
        ])
      }
    }
    const error = await rejection(lifecycle.load(request_()))
    expect(error.code).toBe('OUT_OF_MEMORY')
    expect((error as ManagedLoadError).classification?.numbers).toEqual({ requested_gib: 0.05 })
    const details = error.details ?? ''
    expect(
      details.startsWith('CUDA out of memory. Tried to allocate 0.05 GiB\n[…] the end of the log:\n')
    ).toBe(true)
    expect(details.endsWith('RuntimeError: Executor worker returned error\n')).toBe(true)
    expect(details).not.toContain('loading weights')
    expect(docker.calls.some((argv) => argv.includes('logs') && argv.includes('all'))).toBe(true)
    expect(lifecycle.lastAttempt('org/model-a')?.log_tail).toBe(details)
  })

  it('still classifies from the tail when reading the whole log fails', async () => {
    await build({
      exec: async (args, options) =>
        args.includes('logs') && args.includes('all')
          ? { code: 1, stdout: '', stderr: 'Error response from daemon: context deadline exceeded' }
          : docker.exec(args, options),
    })
    readyAt = null
    onProbe = (now) => {
      if (now === 3_000)
        docker.exit(docker.last().id, 1, [
          'loading weights',
          'CUDA out of memory. Tried to allocate 2.00 GiB',
        ])
    }
    const error = await rejection(lifecycle.load(request_()))
    expect(error.code).toBe('OUT_OF_MEMORY')
    expect(error.details).toBe('loading weights\nCUDA out of memory. Tried to allocate 2.00 GiB\n')
  })

  it('shows the end of the whole log when only the tail read failed, never an empty tail under a header', async () => {
    await build({
      exec: async (args, options) =>
        args.includes('logs') && !args.includes('all')
          ? { code: 1, stdout: '', stderr: 'Error response from daemon: context deadline exceeded' }
          : docker.exec(args, options),
    })
    readyAt = null
    onProbe = (now) => {
      if (now === 3_000)
        docker.exit(docker.last().id, 1, [
          'loading weights',
          'CUDA out of memory. Tried to allocate 2.00 GiB',
        ])
    }
    const error = await rejection(lifecycle.load(request_()))
    expect(error.code).toBe('OUT_OF_MEMORY')
    expect(error.details).toBe('loading weights\nCUDA out of memory. Tried to allocate 2.00 GiB\n')
  })

  it("classifies with the engine's own adapter: the second engine maps its exit to MODEL_INCOMPATIBLE", async () => {
    await build()
    readyAt = null
    onProbe = (now) => {
      if (now === 3_000) docker.exit(docker.last().id, 2, ['unsupported architecture FooForCausalLM'])
    }
    const error = await rejection(lifecycle.load(request_({ installation: betaInstallation })))
    expect(error.code).toBe('MODEL_INCOMPATIBLE')
    expect(error.details).toContain('unsupported architecture')
  })

  it('keeps the last attempt logs after a failure, until the next load of that model', async () => {
    await build()
    readyAt = null
    onProbe = (now) => {
      if (now === 2_000) docker.exit(docker.last().id, 1, ['boom'])
    }
    await rejection(lifecycle.load(request_()))
    expect(lifecycle.lastAttempt('org/model-a')).toMatchObject({
      generation: 'gen-1',
      log_tail: 'boom\n',
      error: { code: 'MODEL_LOAD_FAILED' },
    })
    expect(await lifecycle.logs('org/model-a')).toBe('boom\n')
    expect(lifecycle.lastAttempt('other-model')).toBeUndefined()

    onProbe = undefined
    readyAt = 0
    await lifecycle.load(request_())
    expect(lifecycle.lastAttempt('org/model-a')).toBeUndefined()
  })
})

describe('ManagedTextLifecycle: container, cache, journal, heartbeat', () => {
  it('reuses the engine cache directory on the second load, contents kept', async () => {
    await build()
    await lifecycle.load(request_())
    const cacheDir = data.layout.managed.engineCacheDir('engine-1.0-r1', 'org/model-a')
    const mountOf = (argv: string[]) => argv.find((a) => a.endsWith(':/atomic/engine-cache:rw'))
    expect(mountOf(docker.last().createArgv)).toBe(`${real(cacheDir)}:/atomic/engine-cache:rw`)
    await writeFile(join(cacheDir, 'engine.plan'), 'built on first start')
    await lifecycle.unload('org/model-a')

    await lifecycle.load(request_())
    expect(mountOf(docker.last().createArgv)).toBe(`${real(cacheDir)}:/atomic/engine-cache:rw`)
    expect(await readFile(join(cacheDir, 'engine.plan'), 'utf8')).toBe('built on first start')
  })

  it('runs the engine under the watchdog as PID 1 with the heartbeat dir mounted and the model read-only', async () => {
    await build()
    await lifecycle.load(request_())
    const argv = docker.last().createArgv
    const script = data.layout.managed.watchdogScript
    expect((await stat(script)).mode & 0o777).toBe(0o555)
    expect(argv).toContain(`${real(script)}:/atomic/entrypoint.sh:ro`)
    expect(argv).toContain(`${real(data.layout.managed.heartbeatDir('gen-1'))}:/atomic/heartbeat:ro`)
    expect(argv).toContain(`${real(modelDir)}:/atomic/model:ro`)
    expect(argv.slice(argv.indexOf('--entrypoint'), argv.indexOf('--entrypoint') + 2)).toEqual([
      '--entrypoint',
      '/atomic/entrypoint.sh',
    ])
    expect(argv).toContain('ATOMIC_WATCHDOG_HEARTBEAT_FILE=/atomic/heartbeat/heartbeat')
    expect(argv).toContain('ALPHA_MODE=fast')
    expect(argv).not.toContain('--pid=host')
    const image = argv.indexOf(`registry.example/alpha@${DIGEST}`)
    expect(argv.slice(image + 1)).toEqual([
      '--',
      'alpha-serve',
      '/atomic/model',
      '--cache',
      '/atomic/engine-cache',
      '--ctx',
      '4096',
    ])
    expect(existsSync(join(data.layout.managed.heartbeatDir('gen-1'), 'heartbeat'))).toBe(true)
  })

  it('on Windows (spec «Проверка параметров запуска на Windows»): guest paths, uid 1000, loopback only, the same limits as Linux', async () => {
    // The guest's filesystem as core reaches it (in production `\\wsl.localhost\AtomicChat\…`; here a
    // folder standing in for it), and the resolver that turns it into what the guest's Docker mounts.
    const guestFs = join(data.root, 'guest-fs')
    const scope = join(guestFs, 'var', 'lib', 'atomic-chat', 'scopes', 'k1')
    const guestModel = join(scope, 'models', 'tensorrt-llm', 'model-a')
    await mkdir(guestModel, { recursive: true })
    const toGuest = (path: string): string =>
      `/${path
        .slice(guestFs.length + 1)
        .split(/[\\/]/)
        .join('/')}`
    const guestPaths = {
      ...data.layout.managed,
      root: scope,
      heartbeatsDir: join(scope, 'heartbeats'),
      heartbeatDir: (generation: string) => join(scope, 'heartbeats', generation),
      cachesDir: join(scope, 'caches'),
      descriptorCachesDir: (descriptor: string) => join(scope, 'caches', descriptor),
      engineCacheDir: (descriptor: string, model: string) =>
        join(scope, 'caches', descriptor, model.replace('/', '%2F')),
      watchdogScript: join(scope, 'watchdog', 'atomic-watchdog-entrypoint.sh'),
    }
    const resolved: string[] = []
    await build({
      paths: guestPaths,
      deployment: createDesktopManagedDeployment({
        allocateHostPort: async () => 41_500,
        mountSource: toGuest,
      }),
      // `realpath` runs in the guest: a path is resolved where Docker will mount it.
      createContainerDeps: {
        realpath: async (path) => {
          resolved.push(path)
          return path
        },
      },
      containerUser: { uid: 1000, gid: 1000 },
    })
    await lifecycle.load(request_({ modelPath: guestModel }))
    const argv = docker.last().createArgv

    const guestScope = '/var/lib/atomic-chat/scopes/k1'
    expect(argv).toContain(`${guestScope}/models/tensorrt-llm/model-a:/atomic/model:ro`)
    expect(argv).toContain(`${guestScope}/watchdog/atomic-watchdog-entrypoint.sh:/atomic/entrypoint.sh:ro`)
    expect(argv).toContain(`${guestScope}/heartbeats/gen-1:/atomic/heartbeat:ro`)
    expect(
      argv.some(
        (a) => a.startsWith(`${guestScope}/caches/engine-1.0-r1/`) && a.endsWith(':/atomic/engine-cache:rw')
      )
    ).toBe(true)
    expect(resolved.every((path) => path.startsWith(guestScope))).toBe(true)
    expect(argv.slice(argv.indexOf('--user'), argv.indexOf('--user') + 2)).toEqual(['--user', '1000:1000'])
    const publish = argv[argv.indexOf('-p') + 1]
    expect(publish).toMatch(/^127\.0\.0\.1:/)
    // The same limits a Linux container gets, nothing loosened for Windows.
    const linux = await (async () => {
      await lifecycle.unload('org/model-a')
      await build()
      await lifecycle.load(request_())
      return docker.last().createArgv
    })()
    const limits = (all: string[]) =>
      all.filter((a) =>
        /^--(cap-drop|security-opt|read-only|pids-limit|shm-size|ulimit|network|restart|init)/.test(a)
      )
    expect(limits(argv)).toEqual(limits(linux))
  })

  /** An engine whose launch writes one file into its generation's read-only directory (final review I-2). */
  const withFiles = (files: Record<string, string>): ManagedTextAdapter<Record<string, never>> => ({
    ...beta,
    id: 'delta-engine',
    buildLaunch: (c) => ({
      engine: { container_port: 9000 },
      argv: ['delta', '--options', `${c.generationFilesPath}/options.yaml`],
      files,
    }),
  })
  const deltaInstallation = { ...betaInstallation, adapter_id: 'delta-engine' }

  it("writes the launch's files into the generation directory mounted read-only, before docker create (final review I-2)", async () => {
    await build({}, [withFiles({ 'options.yaml': 'guided_decoding_backend: xgrammar\n' })])
    await lifecycle.load(request_({ installation: deltaInstallation }))
    const dir = data.layout.managed.heartbeatDir('gen-1')
    expect(await readFile(join(dir, 'options.yaml'), 'utf8')).toBe('guided_decoding_backend: xgrammar\n')
    const argv = docker.last().createArgv
    expect(argv).toContain(`${real(dir)}:/atomic/heartbeat:ro`)
    expect(argv.at(-1)).toBe('/atomic/heartbeat/options.yaml')
    await lifecycle.unload('org/model-a')
    expect(existsSync(dir)).toBe(false)
  })

  it('tells the adapter whether the card is unified memory, a discrete card when the request does not say', async () => {
    const seen: boolean[] = []
    const probe: ManagedTextAdapter<Record<string, never>> = {
      ...beta,
      id: 'delta-engine',
      buildLaunch: (c) => {
        seen.push(c.unifiedMemory)
        return { engine: { container_port: 9000 }, argv: ['delta'] }
      },
    }
    await build({}, [probe])
    await lifecycle.load(request_({ installation: deltaInstallation }))
    await lifecycle.unload('org/model-a')
    await lifecycle.load(request_({ installation: deltaInstallation, unifiedMemory: true }))
    expect(seen).toEqual([false, true])
  })

  it.each(['heartbeat', '../escape', 'a/b', '', '.', '..'])(
    'refuses a launch file named %j before any docker call',
    async (name) => {
      await build({}, [withFiles({ [name]: 'x' })])
      const error = await rejection(lifecycle.load(request_({ installation: deltaInstallation })))
      expect(error.code).toBe('INVALID_ARGUMENT')
      expect(docker.calls).toEqual([])
    }
  )

  it('runs the container as the core user, with a home, a cache home and a login name inside the engine cache (final review I-1)', async () => {
    await build({ containerUser: { uid: 1234, gid: 5678 } })
    await lifecycle.load(request_())
    const argv = docker.last().createArgv
    expect(argv.slice(argv.indexOf('--user'), argv.indexOf('--user') + 2)).toEqual(['--user', '1234:5678'])
    expect(argv).toEqual(
      expect.arrayContaining([
        'HOME=/atomic/engine-cache/home',
        'XDG_CACHE_HOME=/atomic/engine-cache/xdg-cache',
        'USER=atomic',
        'LOGNAME=atomic',
      ])
    )
    const cacheDir = data.layout.managed.engineCacheDir('engine-1.0-r1', 'org/model-a')
    expect((await stat(join(cacheDir, 'home'))).isDirectory()).toBe(true)
    expect((await stat(join(cacheDir, 'xdg-cache'))).isDirectory()).toBe(true)
  })

  it('leaves the image user alone, and sets no identity env, when no container user is wired', async () => {
    await build()
    await lifecycle.load(request_())
    const argv = docker.last().createArgv
    expect(argv).not.toContain('--user')
    expect(argv.some((a) => a.startsWith('HOME=') || a.startsWith('LOGNAME='))).toBe(false)
  })

  it('journals the container right after create and drops the record only after a confirmed stop and rm', async () => {
    await build()
    await lifecycle.load(request_())
    const id = docker.last().id
    expect(journal.list()).toEqual([
      expect.objectContaining({
        container_id: id,
        engine_id: 'alpha',
        image_digest: DIGEST,
        scope: 'app',
        instance_id: 'core-1',
      }),
    ])
    await lifecycle.unload('org/model-a')
    expect(journal.list()).toEqual([])
    expect(docker.subcommands().slice(-2)).toEqual(['stop', 'rm'])
  })

  it('stops the heartbeat ticker on unload and removes that generation’s heartbeat dir', async () => {
    await build()
    await lifecycle.load(request_())
    expect(tickers).toEqual([{ stopped: false }])
    await lifecycle.unload('org/model-a')
    expect(tickers).toEqual([{ stopped: true }])
    expect(existsSync(data.layout.managed.heartbeatDir('gen-1'))).toBe(false)
    expect(emitted.find((e) => e.name === 'session:unloaded')?.payload).toEqual({
      provider: 'llamacpp-upstream',
      model_id: 'org/model-a',
      pid: null,
    })
  })

  it('fails before any docker call when the first heartbeat never lands', async () => {
    await build({
      startHeartbeat: () => ({ ready: new Promise(() => {}), stop: () => {} }),
      timings: { heartbeatReadyTimeoutMs: 20 },
    })
    const error = await rejection(lifecycle.load(request_()))
    expect(error.code).toBe('IO_ERROR')
    expect(docker.calls).toEqual([])
  })

  it('retries on a new host port when docker start loses the bind race, and journals only the survivor', async () => {
    await build()
    docker.startFailures = [
      'Error response from daemon: Bind for 127.0.0.1:41000 failed: port is already allocated',
    ]
    await lifecycle.load(request_())
    expect(docker.containers.size).toBe(1)
    expect(docker.last().createArgv).toContain('127.0.0.1:41001:8000')
    expect(journal.list().map((r) => r.container_id)).toEqual([docker.last().id])
    expect(probed.every((url) => url.startsWith('http://127.0.0.1:41001/'))).toBe(true)
  })

  it('refuses an adapter this core does not have with MANAGED_ADAPTER_UNAVAILABLE, before touching docker', async () => {
    await build()
    const error = await rejection(
      lifecycle.load(request_({ installation: { ...betaInstallation, adapter_id: 'gamma-engine' } }))
    )
    expect(error.code).toBe('MANAGED_ADAPTER_UNAVAILABLE')
    expect(docker.calls).toEqual([])
  })

  it('refuses settings the adapter rejects, before touching docker', async () => {
    await build()
    const error = await rejection(lifecycle.load(request_({ settings: { ctx: 'big' } })))
    expect(error.code).toBe('INVALID_ARGUMENT')
    expect(docker.calls).toEqual([])
  })

  it('refuses to remove an engine cache a container is using', async () => {
    await build()
    await lifecycle.load(request_())
    expect((await rejection(lifecycle.removeEngineCaches({ modelId: 'org/model-a' }))).code).toBe(
      'MANAGED_RESOURCE_IN_USE'
    )
    await lifecycle.unload('org/model-a')
    expect(await lifecycle.removeEngineCaches({ modelId: 'org/model-a' })).toEqual([
      data.layout.managed.engineCacheDir('engine-1.0-r1', 'org/model-a'),
    ])
  })
})

describe('ManagedTextLifecycle: cancel and stop', () => {
  it('cancel stops and removes the container, publishes no session, and answers MODEL_LOAD_CANCELLED', async () => {
    await build()
    readyAt = null
    const controller = new AbortController()
    onProbe = (now) => {
      if (now === 3_000) controller.abort()
    }
    const error = await rejection(lifecycle.load(request_({ signal: controller.signal })))
    expect(error.code).toBe('MODEL_LOAD_CANCELLED')
    expect(docker.subcommands()).toContain('stop')
    expect(docker.containers.size).toBe(0)
    expect(lifecycle.list()).toEqual([])
    expect(journal.list()).toEqual([])
    expect(progress().some((p) => p.stage === 'ready')).toBe(false)
    expect(tickers.every((t) => t.stopped)).toBe(true)
  })

  it('a cancel during stopping-previous never creates a container', async () => {
    await build()
    const controller = new AbortController()
    const error = await rejection(
      lifecycle.load(
        request_({
          signal: controller.signal,
          stopPrevious: () => {
            controller.abort()
            return new Promise(() => {})
          },
        })
      )
    )
    expect(error.code).toBe('MODEL_LOAD_CANCELLED')
    expect(docker.calls).toEqual([])
  })

  it('hands stopping-previous the load’s own signal, which an unload of the loading model aborts, and its generation', async () => {
    await build()
    let seen: AbortSignal | undefined
    let generation: string | undefined
    const loading = lifecycle.load(
      request_({
        stopPrevious: (signal, gen) => {
          seen = signal
          generation = gen
          return new Promise(() => {})
        },
      })
    )
    for (let i = 0; i < 50 && seen === undefined; i++) await settle(1)
    expect(seen?.aborted).toBe(false)
    // The generation this load's reservation carries.
    expect(lifecycle.reservations()).toEqual([expect.objectContaining({ generation, state: 'loading' })])
    await lifecycle.unload('org/model-a')
    expect(seen?.aborted).toBe(true)
    expect((await rejection(loading)).code).toBe('MODEL_LOAD_CANCELLED')
    expect(docker.calls).toEqual([])
  })

  it('unloading a model that is still loading cancels that load', async () => {
    await build()
    readyAt = null
    onProbe = (now) => {
      if (now === 2_000) void lifecycle.unload('org/model-a')
    }
    expect((await rejection(lifecycle.load(request_()))).code).toBe('MODEL_LOAD_CANCELLED')
    expect(docker.containers.size).toBe(0)
  })

  it('an unconfirmed stop answers MANAGED_STOP_UNCONFIRMED and keeps the reservation until a confirmed retry', async () => {
    await build()
    await lifecycle.load(request_())
    const id = docker.last().id
    docker.stopConfirms = false
    expect((await rejection(lifecycle.unload('org/model-a'))).code).toBe('MANAGED_STOP_UNCONFIRMED')
    expect(lifecycle.list()).toEqual([])
    expect(lifecycle.reservations()).toEqual([
      {
        model_id: 'org/model-a',
        generation: 'gen-1',
        gpu_uuid: GPU,
        container_id: id,
        state: 'stop-unconfirmed',
      },
    ])
    expect(journal.list().map((r) => r.container_id)).toEqual([id])
    expect((await rejection(lifecycle.load(request_()))).code).toBe('MANAGED_STOP_UNCONFIRMED')

    docker.stopConfirms = true
    await lifecycle.unload('org/model-a')
    expect(lifecycle.reservations()).toEqual([])
    expect(journal.list()).toEqual([])
  })

  it('a failed load whose cleanup stop is unconfirmed keeps the reservation too', async () => {
    await build()
    readyAt = null
    docker.stopConfirms = false
    const error = await rejection(lifecycle.load(request_({ timeoutMs: 3_000 })))
    expect(error.code).toBe('MODEL_LOAD_TIMED_OUT')
    expect(lifecycle.reservations()).toEqual([expect.objectContaining({ state: 'stop-unconfirmed' })])
  })
})

describe('ManagedTextLifecycle: session gateway', () => {
  it('rotates the gateway key per generation: the old key gets 401 from the new session', async () => {
    await build()
    const first = await lifecycle.load(request_())
    expect(first.port).not.toBe(41_000) // the gateway port, never the container's published one
    const key1 = first.api_key
    expect(await gatewayGet(first.port, { host: '127.0.0.1', authorization: `Bearer ${key1}` })).toBe(502)
    await lifecycle.unload('org/model-a')
    await expect(
      gatewayGet(first.port, { host: '127.0.0.1', authorization: `Bearer ${key1}` })
    ).rejects.toThrow()

    const second = await lifecycle.load(request_())
    expect(second.generation).toBe('gen-2')
    expect(second.api_key).not.toBe(key1)
    expect(await gatewayGet(second.port, { host: '127.0.0.1', authorization: `Bearer ${key1}` })).toBe(401)
    expect(
      await gatewayGet(second.port, { host: '127.0.0.1', authorization: `Bearer ${second.api_key}` })
    ).toBe(502)
  })

  it("follows the public server's live trusted-hosts array, not a copy taken at load", async () => {
    await build()
    const info = await lifecycle.load(request_())
    const auth = { authorization: `Bearer ${info.api_key}` }
    expect(await gatewayGet(info.port, { host: 'my-box.lan', ...auth })).toBe(403)
    allowedHosts.push('my-box.lan')
    expect(await gatewayGet(info.port, { host: 'my-box.lan', ...auth })).toBe(502)
  })

  it('answers a second load of a loaded model with the same session', async () => {
    await build()
    const first = await lifecycle.load(request_())
    expect(await lifecycle.load(request_())).toBe(first)
    expect(lifecycle.findSession('org/model-a')).toBe(first)
    expect(lifecycle.isLoading('org/model-a')).toBe(false)
  })
})

describe('ManagedTextLifecycle: crash after ready', () => {
  it('reports session:died with a null pid, closes the gateway, stops the heartbeat and keeps the log tail', async () => {
    await build()
    const info = await lifecycle.load(request_())
    const id = docker.last().id
    docker.exit(id, 1, ['CUDA out of memory. Tried to allocate 1.00 GiB'])
    for (let i = 0; i < 500 && !emitted.some((e) => e.name === 'session:died'); i++) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    expect(emitted.find((e) => e.name === 'session:died')?.payload).toEqual({
      provider: 'llamacpp-upstream',
      pid: null,
      model_id: 'org/model-a',
      exit_code: 1,
      signal: null,
      message: 'The GPU ran out of memory (tried to allocate 1.00 GiB).',
    })
    expect(lifecycle.list()).toEqual([])
    expect(tickers[0]?.stopped).toBe(true)
    expect(journal.list()).toEqual([])
    expect(await lifecycle.logs('org/model-a')).toContain('CUDA out of memory')
    await expect(gatewayGet(info.port, { host: '127.0.0.1' })).rejects.toThrow()
  })
})

describe('ManagedTextLifecycle: a crash after ready reads the tail, not the whole log', () => {
  it("classifies from the tail: an out-of-memory line far above it does not decide a ready session's crash", async () => {
    await build({
      timings: {
        pollIntervalMs: 1_000,
        monitorIntervalMs: 1_000,
        heartbeatReadyTimeoutMs: 2_000,
        logTailLines: 3,
      },
    })
    await lifecycle.load(request_())
    const id = docker.last().id
    docker.exit(id, 1, [
      'CUDA out of memory. Tried to allocate 1.00 GiB',
      'served 1000 requests',
      'served 2000 requests',
      'segfault',
    ])
    for (let i = 0; i < 500 && !emitted.some((e) => e.name === 'session:died'); i++) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    expect((emitted.find((e) => e.name === 'session:died')?.payload as { message: string }).message).toBe(
      'alpha exited with 1'
    )
    expect(docker.calls.some((argv) => argv.includes('logs') && argv.includes('all'))).toBe(false)
  })
})

/** Lets every pending microtask and immediate run, enough for the lifecycle to reach its next await on docker. */
async function settle(rounds = 50): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve))
}

/** A promise `docker stop` waits on, released by the test. */
function gateStops(): () => void {
  let release!: () => void
  docker.stopGate = new Promise<void>((resolve) => (release = resolve))
  return () => {
    docker.stopGate = undefined
    release()
  }
}

const unloadedEvents = () => emitted.filter((e) => e.name === 'session:unloaded')

describe('ManagedTextLifecycle: teardown races (review round 1)', () => {
  it('a load while an unload is still stopping waits for it, then starts fresh; the old teardown never touches the new session', async () => {
    await build()
    await lifecycle.load(request_())
    const first = docker.last().id
    const release = gateStops()
    const unloading = lifecycle.unload('org/model-a')
    await settle()
    expect(lifecycle.reservations()).toEqual([
      expect.objectContaining({ state: 'stopping', container_id: first }),
    ])
    expect(lifecycle.findSession('org/model-a')).toBeUndefined()

    const loading = lifecycle.load(request_())
    await settle()
    expect(docker.containers.size).toBe(1) // nothing new is created while the old one is stopping
    release()
    await unloading
    const second = await loading

    expect(second.generation).toBe('gen-2')
    expect(lifecycle.findSession('org/model-a')).toBe(second)
    expect(docker.last().id).not.toBe(first)
    expect(journal.list().map((r) => r.container_id)).toEqual([docker.last().id])
    expect(unloadedEvents()).toHaveLength(1)
    expect(tickers.map((t) => t.stopped)).toEqual([true, false])
  })

  it('a load waiting for a teardown gives up at once when its own signal aborts; the stop goes on (final review M-7)', async () => {
    await build()
    await lifecycle.load(request_())
    const release = gateStops()
    const unloading = lifecycle.unload('org/model-a')
    await settle()
    const controller = new AbortController()
    const loading = rejection(lifecycle.load(request_({ signal: controller.signal })))
    await settle()
    controller.abort()
    expect((await loading).code).toBe('MODEL_LOAD_CANCELLED')
    // Still stopping: the cancelled load neither waited for the stop nor interfered with it.
    expect(lifecycle.reservations()).toEqual([expect.objectContaining({ state: 'stopping' })])
    release()
    await unloading
    expect(lifecycle.reservations()).toEqual([])
    expect(docker.containers.size).toBe(0)
  })

  it('a load while a stop is pending, and that stop is unconfirmed, is refused and keeps the reservation', async () => {
    await build()
    await lifecycle.load(request_())
    const release = gateStops()
    docker.stopConfirms = false
    const unloading = lifecycle.unload('org/model-a')
    await settle()
    const loading = lifecycle.load(request_())
    release()
    expect((await rejection(unloading)).code).toBe('MANAGED_STOP_UNCONFIRMED')
    expect((await rejection(loading)).code).toBe('MANAGED_STOP_UNCONFIRMED')
    expect(lifecycle.reservations()).toEqual([
      expect.objectContaining({ state: 'stop-unconfirmed', generation: 'gen-1' }),
    ])
    expect(docker.subcommands().filter((c) => c === 'create')).toHaveLength(1)
  })

  it('a double unload shares one teardown: one docker stop, one unloaded event', async () => {
    await build()
    await lifecycle.load(request_())
    const release = gateStops()
    const a = lifecycle.unload('org/model-a')
    const b = lifecycle.unload('org/model-a')
    await settle()
    release()
    await Promise.all([a, b])
    expect(docker.subcommands().filter((c) => c === 'stop')).toHaveLength(1)
    expect(unloadedEvents()).toHaveLength(1)
    expect(lifecycle.reservations()).toEqual([])
  })

  it('a load during a crash teardown waits for it; the crash cleanup never touches the new session', async () => {
    await build()
    await lifecycle.load(request_())
    const first = docker.last().id
    const release = gateStops()
    docker.exit(first, 1, ['segfault'])
    for (let i = 0; i < 500 && lifecycle.reservations()[0]?.state !== 'stopping'; i++) await settle(1)
    expect(lifecycle.reservations()).toEqual([expect.objectContaining({ state: 'stopping' })])

    const loading = lifecycle.load(request_())
    await settle()
    release()
    const second = await loading
    await settle()

    expect(emitted.filter((e) => e.name === 'session:died')).toHaveLength(1)
    expect(lifecycle.findSession('org/model-a')).toBe(second)
    expect(journal.list().map((r) => r.container_id)).toEqual([docker.last().id])
    expect(docker.last().id).not.toBe(first)
  })

  it('a crash whose cleanup stop is unconfirmed keeps the reservation', async () => {
    await build()
    await lifecycle.load(request_())
    docker.stopConfirms = false
    docker.exit(docker.last().id, 1, ['gone'])
    for (let i = 0; i < 500 && !emitted.some((e) => e.name === 'session:died'); i++) await settle(1)
    expect(lifecycle.reservations()).toEqual([expect.objectContaining({ state: 'stop-unconfirmed' })])
    expect(journal.list()).toHaveLength(1)
  })
})

describe('ManagedTextLifecycle: review round 1 gaps', () => {
  it('a second load of a model that is still loading is refused with MANAGED_OPERATION_CONFLICT', async () => {
    await build()
    readyAt = null
    let second: Promise<unknown> | undefined
    onProbe = (now) => {
      if (now === 2_000) {
        second = lifecycle.load(request_())
        // `second` rejects synchronously (the conflict check throws before any `await`), long before
        // the first load's own `await` below ever resumes to observe it via `rejection()` — Node
        // flags that gap as an unhandled rejection even though this test does handle it, just later.
        // A no-op catch here only marks the rejection observed for that bookkeeping; `rejection()`
        // below still awaits the same promise and asserts on its real rejection value (findings-
        // 2.13-r3.md item 2).
        second.catch(() => {})
      }
      if (now === 3_000) readyAt = 0
    }
    await lifecycle.load(request_())
    expect((await rejection(second as Promise<unknown>)).code).toBe('MANAGED_OPERATION_CONFLICT')
    expect(docker.subcommands().filter((c) => c === 'create')).toHaveLength(1)
  })

  it('a gateway that fails to start fails the load and cleans everything up', async () => {
    await build({
      startGateway: async () => {
        throw new AtomicCoreError('IO_ERROR', 'Cannot bind the session gateway.')
      },
    })
    const error = await rejection(lifecycle.load(request_()))
    expect(error.code).toBe('IO_ERROR')
    expect(docker.containers.size).toBe(0)
    expect(journal.list()).toEqual([])
    expect(tickers.every((t) => t.stopped)).toBe(true)
    expect(lifecycle.reservations()).toEqual([])
    expect(lifecycle.lastAttempt('org/model-a')?.error.code).toBe('IO_ERROR')
  })

  it('a cancel while the gateway is starting closes that gateway and publishes no session', async () => {
    const controller = new AbortController()
    let closed = false
    await build({
      startGateway: async (options) => {
        const gateway = await startManagedGateway(options)
        controller.abort()
        return {
          ...gateway,
          close: async () => {
            closed = true
            await gateway.close()
          },
        }
      },
    })
    const error = await rejection(lifecycle.load(request_({ signal: controller.signal })))
    expect(error.code).toBe('MODEL_LOAD_CANCELLED')
    expect(closed).toBe(true)
    expect(docker.containers.size).toBe(0)
    expect(lifecycle.list()).toEqual([])
    expect(progress().some((p) => p.stage === 'ready')).toBe(false)
  })

  it("resolves all four mounts through the deployment's one resolver", async () => {
    const seen: string[] = []
    await build({
      deployment: createDesktopManagedDeployment({
        allocateHostPort: async () => 42_000,
        mountSource: (corePath) => {
          seen.push(corePath)
          return corePath
        },
      }),
    })
    await lifecycle.load(request_())
    expect(seen.sort()).toEqual(
      [
        modelDir,
        data.layout.managed.engineCacheDir('engine-1.0-r1', 'org/model-a'),
        data.layout.managed.watchdogScript,
        data.layout.managed.heartbeatDir('gen-1'),
      ].sort()
    )
  })

  it('logs, with the container id, a container it could not remove after the journal write failed', async () => {
    const logged: string[] = []
    const failing = Object.assign(Object.create(journal) as ExecutionJournal, {
      add: async () => {
        throw new Error('ENOSPC')
      },
    })
    await build({ journal: failing, log: (level, message) => logged.push(`${level}: ${message}`) })
    docker.rmFails = true
    await expect(lifecycle.load(request_())).rejects.toThrow('ENOSPC')
    expect(logged.some((line) => line.startsWith('error:') && line.includes('fakecontainer1'))).toBe(true)
  })
})

describe('ManagedTextLifecycle: review round 2 gaps (findings-2.13-r2.md item 4)', () => {
  it("passes the adapter's declared routes/rewritableRoutes to startGateway, and calls rewriteRequestBody bound to the adapter object, not a detached reference", async () => {
    let captured: ManagedGatewayOptions | undefined
    await build(
      {
        startGateway: async (options) => {
          captured = options
          return startManagedGateway(options)
        },
      },
      [gamma]
    )

    await lifecycle.load(
      request_({
        installation: { ...betaInstallation, adapter_id: 'gamma-rewrite-engine', engine_id: 'gamma' },
        settings: { tag: 'custom' },
      })
    )

    expect(captured?.routes).toEqual([
      { method: 'GET', path: '/v1/models' },
      { method: 'POST', path: '/v1/chat/completions' },
    ])
    expect(captured?.rewritableRoutes).toEqual([{ method: 'POST', path: '/v1/chat/completions' }])
    expect(captured?.rewriteRequestBody).toBeDefined()

    // gamma.rewriteRequestBody reads `this.id`, which throws if the lifecycle ever invoked it as a
    // detached function instead of through `adapter.rewriteRequestBody(...)`; it returning gamma's
    // own id (rather than throwing, or `undefined`) is the proof. It also proves this load's own
    // validated settings reached the call, bound once by the lifecycle rather than re-resolved here.
    const result = captured?.rewriteRequestBody?.('/v1/chat/completions', { x: 1 })
    expect(result).toEqual({
      route: '/v1/chat/completions',
      adapterId: 'gamma-rewrite-engine',
      settingsTag: 'custom',
      body: { x: 1 },
    })
  })
})

describe('ManagedTextLifecycle: carry-forward into task 2.14', () => {
  it('a load of a ready model with different settings reloads it: old container stopped, a new generation', async () => {
    await build()
    const first = await lifecycle.load(request_({ settings: { ctx: 4096 } }))
    const firstContainer = docker.last().id
    const second = await lifecycle.load(request_({ settings: { ctx: 8192 } }))
    expect(second.generation).toBe('gen-2')
    expect(second).not.toBe(first)
    expect(docker.containers.has(firstContainer)).toBe(false)
    expect(docker.last().createArgv).toContain('8192')
    expect(unloadedEvents()).toHaveLength(1)
    expect(lifecycle.findSession('org/model-a')).toBe(second)
  })

  it('a load of a ready model under another descriptor, image or card reloads it too', async () => {
    await build()
    await lifecycle.load(request_())
    const moved = await lifecycle.load(
      request_({
        installation: { ...request_().installation, descriptor_id: 'engine-1.1-r1' },
      })
    )
    expect(moved.generation).toBe('gen-2')
    const onOtherCard = await lifecycle.load(
      request_({
        installation: { ...request_().installation, descriptor_id: 'engine-1.1-r1' },
        gpuUuid: 'GPU-99999999-2222-3333-4444-555555555555',
      })
    )
    expect(onOtherCard.generation).toBe('gen-3')
    expect(docker.containers.size).toBe(1)
  })

  it('an invalid settings change is refused before the loaded session is touched', async () => {
    await build()
    const first = await lifecycle.load(request_())
    const error = await rejection(lifecycle.load(request_({ settings: { ctx: 'big' } })))
    expect(error.code).toBe('INVALID_ARGUMENT')
    expect(lifecycle.findSession('org/model-a')).toBe(first)
    expect(docker.subcommands()).not.toContain('stop')
  })

  it('shutdown blocks new loads, including one that was waiting for a teardown', async () => {
    await build()
    await lifecycle.load(request_())
    const release = gateStops()
    const unloading = lifecycle.unload('org/model-a')
    await settle()
    const waiting = lifecycle.load(request_())
    await settle()
    const stopping = lifecycle.shutdown()
    release()
    await unloading
    await stopping
    expect((await rejection(waiting)).code).toBe('CORE_NOT_RUNNING')
    expect((await rejection(lifecycle.load(request_()))).code).toBe('CORE_NOT_RUNNING')
    expect(docker.subcommands().filter((c) => c === 'create')).toHaveLength(1)
  })

  it('a load while a crash is still reading its log tail never returns the dead session', async () => {
    let releaseLogs: (() => void) | undefined
    await build({
      exec: async (args, options) => {
        if (args[2] === 'logs' && releaseLogs === undefined) {
          await new Promise<void>((resolve) => (releaseLogs = resolve))
        }
        return docker.exec(args, options)
      },
    })
    const dead = await lifecycle.load(request_())
    docker.exit(docker.last().id, 1, ['segfault'])
    for (let i = 0; i < 500 && releaseLogs === undefined; i++) await settle(1)
    expect(releaseLogs).toBeDefined()
    expect(lifecycle.findSession('org/model-a')).toBeUndefined()

    const loading = lifecycle.load(request_())
    await settle()
    releaseLogs?.()
    const fresh = await loading
    expect(fresh).not.toBe(dead)
    expect(fresh.generation).toBe('gen-2')
    expect(await lifecycle.logs('org/model-a')).not.toContain('segfault')
    expect(emitted.filter((e) => e.name === 'session:died')).toHaveLength(1)
  })

  it('carries a GPU substitution on every progress event of that load', async () => {
    await build()
    const substituted = { requested_gpu_id: 'GPU-gone', gpu_id: GPU }
    await lifecycle.load(request_({ gpuSubstituted: substituted }))
    expect(progress().length).toBeGreaterThan(1)
    expect(progress().every((p) => p.gpu_substituted?.gpu_id === GPU)).toBe(true)
    emitted = []
    await lifecycle.unload('org/model-a')
    await lifecycle.load(request_())
    expect(progress().every((p) => p.gpu_substituted === undefined)).toBe(true)
  })
})

describe('ManagedTextLifecycle: task 2.14 fix round 1 (findings-2.14-r1.md items 1 and 3)', () => {
  const toolsCapabilities = { ...capabilities, tools: true }
  const delta: ManagedTextAdapter<{ tag: string; ctx: number }> = {
    id: 'delta-engine',
    contractVersion: MANAGED_TEXT_ADAPTER_CONTRACT_VERSION,
    readiness: { path: '/health', expectedStatus: 200 },
    routes: [{ method: 'POST', path: '/v1/chat/completions' }],
    rewritableRoutes: [{ method: 'POST', path: '/v1/chat/completions' }],
    stageMarkers: [],
    validateSettings: (raw) => {
      const r = (raw ?? {}) as { tag?: string; ctx?: number }
      return { tag: r.tag ?? 'default', ctx: r.ctx ?? 4096 }
    },
    buildLaunch: (c) => ({
      engine: { container_port: 8000 },
      argv: ['delta', '--ctx', String(c.settings.ctx)],
    }),
    readinessTimeoutMs: () => 10_000,
    classifyExit: () => ({ kind: 'other', message: 'delta exited' }),
    capabilities: ({ family }) => (family?.tool_parser ? toolsCapabilities : capabilities),
    rewriteRequestBody: (route, body, settings, caps) => ({
      route,
      tag: settings.tag,
      tools: caps.tools,
      body,
    }),
    mapErrorResponse: (route, status, body) => ({ error: { route, status, body } }),
    restartKey: (settings) => settings.ctx,
  }
  const deltaInstallation = {
    ...betaInstallation,
    adapter_id: 'delta-engine',
    engine_id: 'delta',
    descriptor_id: 'delta-1.0-r1',
  }

  async function captureGateway(): Promise<() => ManagedGatewayOptions | undefined> {
    let captured: ManagedGatewayOptions | undefined
    await build(
      {
        startGateway: async (options) => {
          captured = options
          return startManagedGateway(options)
        },
      },
      [delta]
    )
    return () => captured
  }

  it("hands the rewriter this session's capabilities and the gateway the adapter's error mapper, bound to the route", async () => {
    const gateway = await captureGateway()
    await lifecycle.load(
      request_({
        installation: deltaInstallation,
        family: { tool_parser: 'qwen3', reasoning_parser: null, structured_output: true },
      })
    )
    expect(gateway()?.rewriteRequestBody?.('/v1/chat/completions', { x: 1 })).toMatchObject({ tools: true })
    expect(gateway()?.mapErrorResponse?.('/v1/chat/completions', 400, 'boom')).toEqual({
      error: { route: '/v1/chat/completions', status: 400, body: 'boom' },
    })
  })

  it('joins the running session when only settings outside the restart key changed, and enforces the new ones', async () => {
    const gateway = await captureGateway()
    const first = await lifecycle.load(request_({ installation: deltaInstallation, settings: { tag: 'a' } }))
    const again = await lifecycle.load(request_({ installation: deltaInstallation, settings: { tag: 'b' } }))
    expect(again).toBe(first)
    expect(docker.subcommands().filter((c) => c === 'create')).toHaveLength(1)
    expect(gateway()?.rewriteRequestBody?.('/v1/chat/completions', {})).toMatchObject({ tag: 'b' })

    const restarted = await lifecycle.load(
      request_({ installation: deltaInstallation, settings: { tag: 'b', ctx: 8192 } })
    )
    expect(restarted.generation).toBe('gen-2')
    expect(docker.last().createArgv).toContain('8192')
  })
})

describe('ManagedTextLifecycle on Windows: port, forwarding, the distribution held (change add-tensorrt-llm-windows, task 2.7)', () => {
  /** A WSL-shaped deployment: Docker picks the guest port, the guest can be probed, forwarding diagnosed. */
  const wslDeployment = (options: {
    hostPort?: number
    inside?: () => boolean
    diagnose?: () => 'port-taken' | 'not-forwarded'
  }) => {
    const resolved: string[] = []
    const deployment: ManagedDeployment = {
      mountSource: (path) => path,
      prepareLaunch: async (spec, heartbeat) => ({
        publication: { host: '127.0.0.1', host_port: 0, container_port: spec.container_port },
        target: { base_url: 'http://127.0.0.1:0' },
        heartbeat: { core_path: heartbeat, mount_source: heartbeat },
      }),
      resolveTarget: async (containerId, prepared) => {
        resolved.push(containerId)
        const port = options.hostPort ?? 41_777
        return {
          ...prepared,
          publication: { ...prepared.publication, host_port: port },
          target: { base_url: `http://127.0.0.1:${port}` },
        }
      },
      probeInGuest: async () => ((options.inside?.() ?? true) ? 'ready' : 'not-ready'),
      diagnoseForwarding: async () => options.diagnose?.() ?? 'not-forwarded',
      forwardingError: () =>
        new AtomicCoreError(
          'MANAGED_PREREQUISITE_BLOCKED',
          'WSL does not forward the port.',
          'wsl-localhost-forwarding'
        ),
    }
    return { deployment, resolved }
  }

  /** A keeper whose holds are visible, and a VM a test can stop. */
  const keeper = () => {
    let leases = 0
    const listeners: (() => void)[] = []
    return {
      acquire: () => {
        leases += 1
        let released = false
        return {
          release: () => {
            if (released) return
            released = true
            leases -= 1
          },
        }
      },
      held: () => leases > 0,
      onStopped: (listener: () => void) => {
        listeners.push(listener)
        return () => undefined
      },
      leases: () => leases,
      stopVm: () => listeners.forEach((listener) => listener()),
    }
  }

  it('publishes 127.0.0.1::<port>, reads the port Docker chose, and probes and serves through it', async () => {
    const { deployment, resolved } = wslDeployment({ hostPort: 41_777 })
    await build({ deployment })
    await lifecycle.load(request_())
    const argv = docker.last().createArgv
    expect(argv[argv.indexOf('-p') + 1]).toBe('127.0.0.1::8000')
    expect(resolved).toEqual([docker.last().id])
    expect(probed.every((url) => url.startsWith('http://127.0.0.1:41777/'))).toBe(true)
  })

  it('answers inside the guest but not on Windows (forwarding off): the load fails with wsl-localhost-forwarding', async () => {
    readyAt = null // Windows never reaches it
    const { deployment } = wslDeployment({ diagnose: () => 'not-forwarded' })
    await build({ deployment })
    const error = await rejection(lifecycle.load(request_()))
    expect(error).toMatchObject({ code: 'MANAGED_PREREQUISITE_BLOCKED', details: 'wsl-localhost-forwarding' })
    expect(docker.containers.size).toBe(0)
  })

  it('the Windows port taken by another program: one new publication, then served', async () => {
    let attempt = 0
    const { deployment } = wslDeployment({
      diagnose: () => {
        attempt += 1
        // The second container's port is free on Windows: from then on Windows reaches it.
        readyAt = clock
        return 'port-taken'
      },
    })
    readyAt = null
    await build({ deployment })
    await lifecycle.load(request_())
    expect(attempt).toBe(1)
    expect(docker.calls.filter((argv) => argv[0] === 'create')).toHaveLength(2)
    expect(docker.containers.size).toBe(1)
  })

  it('taken twice: no third publication, the forwarding error', async () => {
    readyAt = null
    const { deployment } = wslDeployment({ diagnose: () => 'port-taken' })
    await build({ deployment })
    const error = await rejection(lifecycle.load(request_()))
    expect(error.details).toBe('wsl-localhost-forwarding')
    expect(docker.calls.filter((argv) => argv[0] === 'create')).toHaveLength(2)
  })

  it('holds the distribution while the model loads and is loaded, and not after (spec "Простой")', async () => {
    const k = keeper()
    await build({ deployment: wslDeployment({}).deployment, keeper: k })
    await lifecycle.load(request_())
    expect(k.leases()).toBe(1)
    await lifecycle.unload('org/model-a')
    expect(k.leases()).toBe(0)
  })

  it('wsl --shutdown under a loaded model: the session ends with wsl-stopped, nothing asks Docker, a new load holds again', async () => {
    const k = keeper()
    await build({ deployment: wslDeployment({}).deployment, keeper: k })
    await lifecycle.load(request_())
    const callsBefore = docker.calls.length
    const container = docker.last().id

    k.stopVm()
    await new Promise((resolve) => setImmediate(resolve))

    const died = emitted
      .filter((e) => e.name === 'session:died')
      .map((e) => e.payload as CoreEvents['session:died'])
    expect(died).toEqual([expect.objectContaining({ model_id: 'org/model-a', reason: 'wsl-stopped' })])
    expect(lifecycle.list()).toEqual([])
    expect(k.leases()).toBe(0)
    // The VM took the container with it: no docker call that would start the VM again.
    expect(docker.calls.slice(callsBefore)).toEqual([])
    // The journal keeps the record; the next start's reconcile removes the stopped container.
    expect(journal.list().map((record) => record.container_id)).toContain(container)

    await lifecycle.load(request_())
    expect(k.leases()).toBe(1)
  })
})
