import { afterEach, describe, expect, it } from 'vitest'
import { closeAll, startPublic } from '../../../test/helpers/public-server.js'

afterEach(closeAll)

describe('documentation routes', () => {
  it('points the OpenAPI servers at the bound address and prefix, without CORS headers', async () => {
    const server = await startPublic({}, { prefix: '/api' })

    const res = await fetch(`http://127.0.0.1:${server.port}/openapi.json`, {
      headers: { origin: 'http://localhost:3000' },
    })
    const spec = (await res.json()) as { servers: Array<{ url: string }> }

    expect(spec.servers.every((s) => s.url === `http://127.0.0.1:${server.port}/api`)).toBe(true)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })
})
