import { afterEach, describe, expect, it } from 'vitest'
import { invalidJsonMessage } from './exchange.js'
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
})
