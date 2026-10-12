import { createHmac } from 'node:crypto'
import { createServer } from 'node:net'
import { describe, expect, it } from 'vitest'
import {
  exitedOnTakenPort,
  generateApiKey,
  isPortAvailable,
  PORT_EXHAUSTED_MESSAGE,
  PORT_TAKEN_ATTEMPTS,
  randomFreePort,
  retryOnTakenPort,
} from './ports.js'

describe('randomFreePort', () => {
  it('skips used ports and unavailable ones, returns the first bindable candidate', async () => {
    const seq = [3001, 3002, 3003]
    let i = 0
    const port = await randomFreePort([3001], {
      random: () => seq[i++] as number,
      isAvailable: async (p) => p === 3003,
    })
    expect(port).toBe(3003)
  })
  it('never hands out a port fetch refuses to connect to', async () => {
    const seq = [3659, 6000, 3660]
    let i = 0
    const port = await randomFreePort([], { random: () => seq[i++] as number, isAvailable: async () => true })
    expect(port).toBe(3660)
  })
  it('gives up with the Rust message after the attempt budget', async () => {
    await expect(
      randomFreePort([], { attempts: 3, random: () => 3000, isAvailable: async () => false })
    ).rejects.toThrow(PORT_EXHAUSTED_MESSAGE)
  })
  it('isPortAvailable reports a bound port as taken', async () => {
    const server = createServer()
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    expect(await isPortAvailable(port)).toBe(false)
    await new Promise<void>((r) => server.close(() => r()))
    expect(await isPortAvailable(port)).toBe(true)
  })
})

describe('generateApiKey', () => {
  it('is HMAC-SHA256 over modelId+port, base64, with the legacy default secret', () => {
    expect(generateApiKey('org/model', 3456)).toBe(
      createHmac('sha256', 'JustAskNow').update('org/model3456').digest('base64')
    )
    expect(generateApiKey('org/model', 3456, 's')).not.toBe(generateApiKey('org/model', 3456))
    expect(generateApiKey('org/model', 3457)).not.toBe(generateApiKey('org/model', 3456))
  })
})

describe('exitedOnTakenPort', () => {
  it.each([
    [
      "llama-server's own words",
      "start: couldn't bind HTTP server socket, hostname: 127.0.0.1, port: 3123",
      true,
    ],
    ["Node's", 'Error: listen EADDRINUSE: address already in use 127.0.0.1:3123', true],
    ['an out-of-memory exit', 'ggml_backend_cuda_buffer_type_alloc_buffer: failed to allocate', false],
    ['no details at all', undefined, false],
  ])('%s -> %s', (_label, details, taken) => {
    expect(exitedOnTakenPort(details)).toBe(taken)
  })
})

describe('retryOnTakenPort', () => {
  const taken = new Error('port taken')
  const isTaken = (error: unknown) => error === taken

  it('starts again while the port was taken, and returns the first start that works', async () => {
    let calls = 0
    const retried: number[] = []
    const value = await retryOnTakenPort(
      async () => {
        calls += 1
        if (calls < 3) throw taken
        return 'up'
      },
      isTaken,
      (attempt) => retried.push(attempt)
    )
    expect(value).toBe('up')
    expect(retried).toEqual([1, 2])
  })

  it('gives up after its attempts with the last failure', async () => {
    let calls = 0
    await expect(
      retryOnTakenPort(async () => {
        calls += 1
        throw taken
      }, isTaken)
    ).rejects.toBe(taken)
    expect(calls).toBe(PORT_TAKEN_ATTEMPTS)
  })

  it('takes as many attempts as it is given', async () => {
    let calls = 0
    await expect(
      retryOnTakenPort(
        async () => {
          calls += 1
          throw taken
        },
        isTaken,
        () => {},
        5
      )
    ).rejects.toBe(taken)
    expect(calls).toBe(5)
  })

  it('never retries any other failure', async () => {
    let calls = 0
    const other = new Error('the model is broken')
    await expect(
      retryOnTakenPort(async () => {
        calls += 1
        throw other
      }, isTaken)
    ).rejects.toBe(other)
    expect(calls).toBe(1)
  })
})
