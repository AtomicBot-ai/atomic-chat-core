import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FIRST_RUN_NOTICE, createCoreReporter, systemContext, takeFirstRunNotice } from './core-reporter.js'
import type { CoreReporterInput } from './core-reporter.js'
import { writeTelemetryFile } from './store.js'

let dir: string
let telemetryFile: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atomic-core-reporter-'))
  telemetryFile = join(dir, 'atomic-core', 'telemetry.json')
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function input(over: Partial<CoreReporterInput> = {}) {
  const bodies: string[] = []
  const base: CoreReporterInput = {
    host: 'cli',
    dataFolder: dir,
    telemetryFile,
    homeDir: '/Users/misha',
    env: {},
    platform: 'linux',
    arch: 'x64',
    version: '0.3.0',
    warn: () => {},
    testRun: false,
    baked: { dsn: 'https://k@o1.ingest.us.sentry.io/9', environment: 'production' },
    system: { osRelease: '6.8.0', cpuModel: 'AMD Ryzen 9', memoryMb: 65536 },
    fetch: (async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body))
      return new Response(null)
    }) as unknown as typeof fetch,
    ...over,
  }
  return { base, bodies }
}

describe('systemContext', () => {
  it('knows the kernel release, the CPU and the memory of this machine', () => {
    const system = systemContext()
    expect(system.osRelease).toBeTruthy()
    expect(system.memoryMb).toBeGreaterThan(0)
  })
})

describe('createCoreReporter', () => {
  it('reports by default, as its host, with its own install id and the machine it knows', async () => {
    const { base, bodies } = input()
    const reporter = await createCoreReporter(base)
    expect(reporter.state()).toEqual({
      enabled: true,
      reporting: true,
      has_user: false,
      tags: {},
      source: 'default',
      host: 'cli',
    })
    reporter.capture({
      source: 'startup',
      level: 'fatal',
      error: new Error(`EACCES ${dir}/atomic-core/lock`),
    })
    await reporter.flush()
    const event = JSON.parse(bodies[0]!.split('\n')[2]!)
    const installId = JSON.parse(await readFile(telemetryFile, 'utf8')).install_id as string
    expect(event).toMatchObject({
      environment: 'production',
      user: { id: installId, ip_address: null },
      tags: { host: 'cli', cpu_model: 'AMD Ryzen 9', system_ram_mb: '65536' },
      contexts: {
        os: { name: 'linux', version: '6.8.0' },
        device: { arch: 'x64', memory_size: 65536 * 1024 * 1024 },
      },
    })
    expect(event.exception.values[0].value).toBe('EACCES <data>/atomic-core/lock')
    expect((await createCoreReporter(base)).state()).toMatchObject({ enabled: true })
    expect(JSON.parse(await readFile(telemetryFile, 'utf8')).install_id).toBe(installId)
  })

  it("lets the host's user win over the install id, and its tags over the core's own", async () => {
    const { base, bodies } = input({ host: 'atomic-chat', hostVersion: '2.0.44' })
    const reporter = await createCoreReporter(base)
    reporter.update({ user_id: 'distinct-1', tags: { system_ram_mb: '32768', app_version: '2.0.44' } })
    reporter.capture({ source: 'inference', level: 'warning', message: 'x' })
    await reporter.flush()
    const event = JSON.parse(bodies[0]!.split('\n')[2]!)
    expect(event.user.id).toBe('distinct-1')
    expect(event.tags).toMatchObject({ host: 'atomic-chat', host_version: '2.0.44', system_ram_mb: '32768' })
  })

  it('honours the stored choice, the environment and the host, in that order of strength', async () => {
    await writeTelemetryFile(telemetryFile, { enabled: false })
    expect((await createCoreReporter(input().base)).state()).toMatchObject({
      enabled: false,
      source: 'stored',
    })
    expect((await createCoreReporter(input({ enabled: true }).base)).state()).toMatchObject({
      enabled: true,
      source: 'host',
    })
    expect(
      (await createCoreReporter(input({ enabled: true, env: { DO_NOT_TRACK: '1' } }).base)).state()
    ).toMatchObject({ enabled: false, source: 'env' })
  })

  it('writes nothing and reports nowhere under a test runner', async () => {
    const reporter = await createCoreReporter(input({ baked: {}, testRun: true }).base)
    expect(reporter.state()).toMatchObject({ enabled: true, reporting: false })
    await expect(readFile(telemetryFile, 'utf8')).rejects.toThrow()
    const inherited = await createCoreReporter({ ...input({ baked: {} }).base, testRun: undefined })
    expect(inherited.state().reporting).toBe(false)
  })
})

describe('takeFirstRunNotice', () => {
  const notice = (over: Partial<Parameters<typeof takeFirstRunNotice>[0]> = {}) =>
    takeFirstRunNotice({ telemetryFile, env: {}, version: '0.3.0', testRun: false, baked: {}, ...over })

  it('is shown once per data folder, when reports go out only by default', async () => {
    expect(await notice()).toBe(true)
    expect(await notice()).toBe(false)
    expect(FIRST_RUN_NOTICE).toContain('atomic-chat-core telemetry off')
  })

  it('is not shown when someone already decided, or nothing would be sent', async () => {
    expect(await notice({ env: { DO_NOT_TRACK: '1' } })).toBe(false)
    expect(await notice({ testRun: true })).toBe(false)
    expect(await notice({ testRun: undefined })).toBe(false)
    await writeTelemetryFile(telemetryFile, { enabled: true })
    expect(await notice()).toBe(false)
  })
})
