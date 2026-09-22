import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { clientGone, invalidJsonMessage, requestAborted } from './exchange.js'
import type { Exchange } from './exchange.js'
import { closeAll, startPublic } from '../../../test/helpers/public-server.js'

afterEach(closeAll)

describe('exchange', () => {
  it("prefixes a parse failure with the proxy's wording", () => {
    expect(invalidJsonMessage(new Error('Unexpected token'))).toBe('Invalid JSON body: Unexpected token')
  })

  it('reflects a trusted origin on routed answers', async () => {
    const server = await startPublic({})

    const res = await fetch(`http://127.0.0.1:${server.port}/v1/nowhere`, {
      headers: { origin: 'http://localhost:5173' },
    })

    expect(res.status).toBe(404)
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173')
  })

  describe('clientGone', () => {
    /** A request and response as the handlers see them, before any answer has been written. */
    const pending = (res: object = {}) => {
      const response = Object.assign(new EventEmitter(), { writableFinished: false }, res)
      const ex = { req: new EventEmitter(), res: response } as unknown as Exchange
      return { ex, res: response }
    }
    const settled = (signal: AbortSignal, ms = 100) =>
      new Promise<boolean>((resolve) => {
        if (signal.aborted) return resolve(true)
        const timer = setTimeout(() => resolve(false), ms)
        signal.addEventListener('abort', () => {
          clearTimeout(timer)
          resolve(true)
        })
      })

    it("aborts on the response's close before the answer is finished, as Node reports it", async () => {
      const { ex, res } = pending()
      const signal = clientGone(ex, 10)
      res.emit('close')
      expect(await settled(signal)).toBe(true)
    })

    it('does not abort once the answer is finished', async () => {
      const { ex, res } = pending()
      const signal = clientGone(ex, 10)
      res.writableFinished = true
      res.emit('finish')
      res.emit('close')
      expect(await settled(signal, 50)).toBe(false)
    })

    it("aborts when Bun's response handle says the client left, which no event reports", async () => {
      // Bun keeps its native handle on the response under a symbol described `handle`; only its
      // `aborted` flag moves.
      const handle = { aborted: false }
      const { ex } = pending({ [Symbol('handle')]: handle })
      expect(requestAborted(ex.req, ex.res)).toBe(false)
      const signal = clientGone(ex, 10)
      expect(await settled(signal, 50)).toBe(false)
      handle.aborted = true
      expect(requestAborted(ex.req, ex.res)).toBe(true)
      expect(await settled(signal, 500)).toBe(true)
    })

    it('reads a destroyed socket as the client gone', () => {
      const res = {} as ServerResponse
      expect(requestAborted({ socket: { destroyed: true } } as unknown as IncomingMessage, res)).toBe(true)
      expect(requestAborted({ socket: { destroyed: false } } as unknown as IncomingMessage, res)).toBe(false)
    })
  })
})
