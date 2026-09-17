import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createPolicyFetch } from '../../src/downloads/proxy-fetch.js'
import { tlsFixture } from '../helpers/proxy-servers.js'

// The remote-access probe reaches a new tunnel through Cloudflare's edge before its name resolves
// anywhere, and the edge routes on the TLS server name (stage 7d). A runtime that ignored the address
// pin would try to resolve a name that does not exist; one that sent no server name would reach the
// wrong tunnel. Both have to hold under Node (vitest) and Bun (`bun test`), so the stand-in edge runs
// under Node in its own process and reports what arrived on the wire — Bun's own TLS server does not
// expose the server name it was offered.
//
// Its own file on purpose: next to the in-process proxy servers of `proxy-fetch.test.ts`, the refused
// handshake below segfaults `bun test` 1.3.10 about one run in three. The same requests under
// `bun run` — forty refused handshakes of each kind with forced collection in between — do not.

const NAME = 'calm-river-demo.trycloudflare.com'
const TLS_DIR = fileURLToPath(new URL('../fixtures/tls/', import.meta.url))
const EDGE_SCRIPT = fileURLToPath(new URL('../helpers/sni-echo-server.mjs', import.meta.url))

describe('a pinned address on this runtime', () => {
  it('is dialled while SNI, the certificate check and Host stay on the URL name', async () => {
    const edge = spawn('node', [EDGE_SCRIPT, join(TLS_DIR, 'tunnel.key'), join(TLS_DIR, 'tunnel.pem')], {
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    try {
      const port = await new Promise<number>((resolve, reject) => {
        edge.once('error', reject)
        edge.stdout.once('data', (line: Buffer) =>
          resolve((JSON.parse(line.toString()) as { port: number }).port)
        )
      })
      const pinned = createPolicyFetch({
        ca: tlsFixture('tunnel.pem'),
        connectTo: { host: '127.0.0.1', port },
      })

      const res = await pinned(`https://${NAME}/openapi.json`)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ servername: NAME, host: NAME })

      // Same server, another tunnel's name: the certificate does not cover it.
      const refused = await pinned('https://other-name.trycloudflare.com/openapi.json').then(
        () => 'accepted',
        (error: Error) => error.message
      )
      expect(refused).toMatch(/altnames|certificate|hostname/i)
    } finally {
      edge.kill('SIGTERM')
    }
  })
})
