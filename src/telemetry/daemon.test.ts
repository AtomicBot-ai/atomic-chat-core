import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { AtomicCoreError } from '../contracts/index.js'
import {
  breadcrumbLogger,
  failFatally,
  installProcessHandlers,
  parseTelemetryFlag,
  processHandlersFor,
} from './daemon.js'
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
    [undefined, undefined],
    ['off', false],
    ['on', true],
  ])('%s → %s', (value, enabled) => {
    expect(parseTelemetryFlag(value)).toBe(enabled)
  })

  it('refuses anything else', () => {
    expect(() => parseTelemetryFlag('yes')).toThrow('--telemetry takes "on" or "off", not "yes".')
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

describe('processHandlersFor', () => {
  it('binds the handlers to a process, its stderr and its exit', async () => {
    const target = new EventEmitter()
    const stderr: string[] = []
    const exits: number[] = []
    const captured: unknown[] = []
    processHandlersFor(
      target,
      (text) => stderr.push(text),
      (code) => exits.push(code)
    )({ reporter: { capture: (r) => captured.push(r), flush: async () => {} } })
    target.emit('uncaughtException', new Error('late'))
    await vi.waitFor(() => expect(exits).toEqual([1]))
    expect(stderr[0]).toContain('late')
    expect(captured).toHaveLength(1)
  })
})

describe('breadcrumbLogger', () => {
  it('writes every line and keeps warnings and errors as breadcrumbs', () => {
    const written: string[] = []
    const crumbs: string[] = []
    const log = breadcrumbLogger(
      { breadcrumb: (level, message) => crumbs.push(`${level}:${message}`) },
      (level, message) => written.push(`${level}:${message}`)
    )
    log('info', 'a')
    log('warn', 'b')
    log('error', 'c')
    expect(written).toEqual(['info:a', 'warn:b', 'error:c'])
    expect(crumbs).toEqual(['warning:b', 'error:c'])
  })
})
