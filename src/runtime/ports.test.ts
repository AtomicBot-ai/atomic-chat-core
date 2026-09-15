import { createHmac } from 'node:crypto'
import { createServer } from 'node:net'
import { describe, expect, it } from 'vitest'
import { generateApiKey, isPortAvailable, PORT_EXHAUSTED_MESSAGE, randomFreePort } from './ports.js'

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
