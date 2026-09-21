import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { AtomicCoreError } from '../contracts/index.js'
import { createDaemonReporter, failFatally, installProcessHandlers, parseTelemetryFlag } from './daemon.js'
import type { FatalDeps } from './daemon.js'

function fatalDeps(): FatalDeps & { captured: unknown[]; stderr: string[]; exits: number[] } {
  const captured: unknown[] = []
  const stderr: string[] = []
  const exits: number[] = []
  return {
    captured,
    stderr,
    exits,
    reporter: { capture: (r) => captured.push(r), flush: vi.fn(async () => {}) },
    writeStderr: (text) => stderr.push(text),
    exit: (code) => exits.push(code),
  }
}

describe('parseTelemetryFlag', () => {
  it.each([
    [undefined, false],
    ['off', false],
    ['on', true],
  ])('%s → %s', (value, enabled) => {
    expect(parseTelemetryFlag(value)).toBe(enabled)
  })

  it('refuses anything else', () => {
    expect(() => parseTelemetryFlag('yes')).toThrow('--telemetry takes "on" or "off", not "yes".')
  })
})

describe('createDaemonReporter', () => {
  const base = {
    dataFolder: '/Users/misha/Library/Application Support/Atomic Chat/data',
    homeDir: '/Users/misha',
    platform: 'darwin' as const,
    arch: 'arm64',
    version: '0.3.0',
    warn: () => {},
  }

  it('reports to the baked project with the app consent and scrubs the data folder', async () => {
    const bodies: string[] = []
    const reporter = createDaemonReporter({
      ...base,
      enabled: true,
      env: {},
      baked: { dsn: 'https://k@o1.ingest.us.sentry.io/9', environment: 'production' },
      fetch: (async (_url: string, init: RequestInit) => {
        bodies.push(String(init.body))
        return new Response(null)
      }) as unknown as typeof fetch,
    })
    expect(reporter.state()).toEqual({ enabled: true, reporting: true, has_user: false, tags: {} })
    reporter.capture({
      source: 'startup',
      level: 'fatal',
      error: new Error(`EACCES ${base.dataFolder}/atomic-core/lock`),
    })
    await reporter.flush()
    const event = JSON.parse(bodies[0]!.split('\n')[2]!)
    expect(event.exception.values[0].value).toBe('EACCES <data>/atomic-core/lock')
    expect(event.tags.owner_scope).toBe('app')
    expect(event.release).toBe('atomic-chat-core@0.3.0')
  })

  it('has nowhere to report without a baked or configured DSN', () => {
    const reporter = createDaemonReporter({ ...base, enabled: true, env: {} })
    expect(reporter.state().reporting).toBe(false)
  })
})

describe('failFatally', () => {
  it('writes the error, reports it, waits for the send and exits 1', async () => {
    const deps = fatalDeps()
    const error = new TypeError('boom')
    await failFatally('uncaught_exception', error, deps)
    expect(deps.stderr[0]).toContain('TypeError: boom')
    expect(deps.captured).toEqual([
      { source: 'uncaught_exception', level: 'fatal', error, tags: expect.any(Object) },
    ])
    expect(deps.reporter.flush).toHaveBeenCalledWith(2_000)
    expect(deps.exits).toEqual([1])
  })

  it('exits without a report when the failure is not one, or stderr is gone', async () => {
    const deps = fatalDeps()
    deps.writeStderr = () => {
      throw new Error('EPIPE')
    }
    await failFatally('startup', new AtomicCoreError('CORE_ALREADY_RUNNING', 'owned'), {
      ...deps,
      flushTimeoutMs: 5,
    })
    expect(deps.captured).toEqual([])
    expect(deps.reporter.flush).not.toHaveBeenCalled()
    expect(deps.exits).toEqual([1])
  })
})

describe('installProcessHandlers', () => {
  it('reports the first uncaught failure once and exits', async () => {
    const target = new EventEmitter()
    const deps = fatalDeps()
    installProcessHandlers(target, deps)
    target.emit('unhandledRejection', new Error('first'))
    target.emit('uncaughtException', new Error('second'))
    await vi.waitFor(() => expect(deps.exits).toEqual([1]))
    expect(deps.captured).toHaveLength(1)
    expect(deps.captured[0]).toMatchObject({ source: 'unhandled_rejection' })
  })

  it('reports an uncaught exception as such', async () => {
    const target = new EventEmitter()
    const deps = fatalDeps()
    installProcessHandlers(target, deps)
    target.emit('uncaughtException', new Error('x'))
    await vi.waitFor(() => expect(deps.exits).toEqual([1]))
    expect(deps.captured[0]).toMatchObject({ source: 'uncaught_exception' })
  })
})
