import { describe, expect, it } from 'vitest'
import type { WslDistributionTransport } from '../wsl/index.js'
import { checkLocalhostForwarding, localhostForwardingError } from './windows-forwarding.js'
import type { WslConfigFacts } from './windows-probe.js'

const NONE: WslConfigFacts = { networking_mode: null, localhost_forwarding: null, memory: null }

describe('localhostForwardingError', () => {
  it('names the setting to put back when the user turned forwarding off, and never changes it', () => {
    const error = localhostForwardingError({ ...NONE, localhost_forwarding: false })
    expect(error).toMatchObject({ code: 'MANAGED_PREREQUISITE_BLOCKED', details: 'wsl-localhost-forwarding' })
    expect(error.message).toMatch(/localhostForwarding=true/)
    expect(error.message).toMatch(/wsl --shutdown/)
  })

  it('names mirrored networking when that is what the user runs', () => {
    expect(localhostForwardingError({ ...NONE, networking_mode: 'mirrored' }).message).toMatch(/mirrored/)
  })

  it('without a .wslconfig says what to check', () => {
    expect(localhostForwardingError(NONE).message).toMatch(/\.wslconfig/)
  })
})

/** A guest that can run a test listener, and a Windows side that reaches it only if forwarding works. */
const machine = (forwarding: boolean, listenerStarts = true) => {
  const listening = new Set<number>()
  const calls: string[][] = []
  const transport: WslDistributionTransport = {
    name: 'AtomicChat',
    exec: async (argv, options = {}) => {
      calls.push(argv)
      if (argv.includes('http.server')) {
        const port = Number(argv[argv.length - 1])
        if (listenerStarts) listening.add(port)
        // The listener runs until the check is done with it.
        await new Promise<void>((resolve) => options.signal?.addEventListener('abort', () => resolve()))
        listening.delete(port)
        return { code: null, stdout: '', stderr: 'aborted' }
      }
      if (argv[0] === 'curl') {
        const port = Number(/127\.0\.0\.1:(\d+)/.exec(argv[argv.length - 1] as string)?.[1])
        return { code: 0, stdout: listening.has(port) ? '200' : '000', stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    },
    hold: () => {
      throw new Error('no hold')
    },
  }
  const fetchImpl = (async (url: string | URL | Request) => {
    const port = Number(new URL(String(url)).port)
    if (forwarding && listening.has(port)) return new Response('ok', { status: 200 })
    throw new TypeError('fetch failed: connect ECONNREFUSED')
  }) as typeof fetch
  return { transport, fetchImpl, calls, listening }
}

const signal = new AbortController().signal
const noSleep = async (): Promise<void> => undefined

describe('checkLocalhostForwarding', () => {
  it('passes when a port listening in the guest answers on Windows’ 127.0.0.1 (mirrored networking included)', async () => {
    const m = machine(true)
    await checkLocalhostForwarding({
      transport: m.transport,
      fetch: m.fetchImpl,
      sleep: noSleep,
      wslconfig: { ...NONE, networking_mode: 'mirrored' },
      port: () => 45_123,
      signal,
    })
    expect(m.calls[0]).toEqual([
      'timeout',
      '120',
      'python3',
      '-m',
      'http.server',
      '--bind',
      '127.0.0.1',
      '45123',
    ])
    expect(m.listening.size).toBe(0)
  })

  it('fails with wsl-localhost-forwarding when the guest answers and Windows does not', async () => {
    const m = machine(false)
    await expect(
      checkLocalhostForwarding({
        transport: m.transport,
        fetch: m.fetchImpl,
        sleep: noSleep,
        wslconfig: { ...NONE, localhost_forwarding: false },
        port: () => 45_124,
        signal,
      })
    ).rejects.toMatchObject({ details: 'wsl-localhost-forwarding' })
    expect(m.listening.size).toBe(0)
  })

  it('a listener that never comes up inside is not a forwarding problem: it says so', async () => {
    const m = machine(true, false)
    await expect(
      checkLocalhostForwarding({
        transport: m.transport,
        fetch: m.fetchImpl,
        sleep: noSleep,
        wslconfig: NONE,
        port: () => 45_125,
        signal,
      })
    ).rejects.toMatchObject({ code: 'IO_ERROR' })
  })
})
