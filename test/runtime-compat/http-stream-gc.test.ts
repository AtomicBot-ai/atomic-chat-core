import { describe, expect, it } from 'vitest'
import { sendUpstream } from '../../src/server/public/wire.js'
import { delayedSseServer } from '../helpers/delayed-sse.js'

// Run on Node and on `bun --expose-gc test`: a large image POST followed by
// small, delayed SSE frames used to stop after its first role-only frame under
// Bun 1.3.10 when GC ran. No model, image, private prompt, or external service.
const collectGarbage = (globalThis as { gc?: () => void }).gc

describe('loopback HTTP response lifetime', () => {
  it('delivers every delayed frame and EOF under GC after a large POST', async () => {
    const upstream = await delayedSseServer()
    const gc = collectGarbage ? setInterval(collectGarbage, 10) : undefined
    try {
      for (let turn = 0; turn < 12; turn++) {
        const controller = new AbortController()
        const body = Buffer.alloc(1_200_000, 'x')
        const response = await sendUpstream(upstream.url, {
          method: 'POST',
          headers: [],
          body,
          connectTimeoutMs: 2000,
          signal: controller.signal,
        })
        let timer: ReturnType<typeof setTimeout> | undefined
        const read = (async () => {
          const chunks: Buffer[] = []
          for await (const chunk of response.body) chunks.push(Buffer.from(chunk))
          return Buffer.concat(chunks).toString()
        })()
        try {
          const text = await Promise.race([
            read,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error('SSE stopped before EOF')), 2000)
            }),
          ])
          expect(text).toBe(upstream.expected)
          expect(response.status).toBe(200)
        } finally {
          clearTimeout(timer)
          controller.abort()
          response.body.destroy()
        }
      }
    } finally {
      if (gc) clearInterval(gc)
      await upstream.close()
    }
  }, 25_000)

  it('aborts a response while delayed body frames are still arriving', async () => {
    const upstream = await delayedSseServer()
    const controller = new AbortController()
    try {
      const response = await sendUpstream(upstream.url, {
        method: 'POST',
        headers: [],
        body: Buffer.alloc(1_200_000),
        connectTimeoutMs: 2000,
        signal: controller.signal,
      })
      const reader = response.body[Symbol.asyncIterator]()
      expect((await reader.next()).done).toBe(false)
      controller.abort()
      let failed = false
      try {
        await reader.next()
      } catch {
        failed = true
      }
      expect(failed).toBe(true)
    } finally {
      controller.abort()
      await upstream.close()
    }
  })

  it('destroy cancels an idle pending body read without waiting for another frame', async () => {
    const upstream = await delayedSseServer(true)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const response = await sendUpstream(upstream.url, {
        method: 'POST',
        headers: [],
        body: Buffer.alloc(1_200_000),
        connectTimeoutMs: 2000,
      })
      const reader = response.body[Symbol.asyncIterator]()
      expect((await reader.next()).done).toBe(false)
      const pending = reader.next().catch(() => ({ done: true }))
      response.body.destroy()
      await Promise.race([
        Promise.all([pending, upstream.closed]),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('destroy left the upstream open')), 1000)
        }),
      ])
      expect(response.body.destroyed).toBe(true)
    } finally {
      clearTimeout(timer)
      await upstream.close()
    }
  })
})
