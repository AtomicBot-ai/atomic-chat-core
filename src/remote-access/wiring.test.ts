import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer as createTlsServer } from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tlsFixture } from '../../test/helpers/proxy-servers.js'
import { fileURLToPath } from 'node:url'
import { PROBE_MARKER } from './probe.js'
import { REMOTE_ACCESS_CA_ENV, REMOTE_ACCESS_EDGE_ENV, parseEdgeAddress, wireRemoteAccess } from './wiring.js'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atomic-remote-access-wiring-'))
})
afterEach(() => rm(dir, { recursive: true, force: true }))

const base = (warnings: string[] = []) => ({
  env: {},
  platform: process.platform,
  journalPath: join(dir, 'remote-access-tunnel.json'),
  emptyConfigPath: join(dir, 'cloudflared-empty.yml'),
  instanceId: 'instance-1',
  warn: (message: string) => void warnings.push(message),
})

describe('parseEdgeAddress', () => {
  it.each([
    ['127.0.0.1:8443', { host: '127.0.0.1', port: 8443 }],
    [' 127.0.0.1:8443 ', { host: '127.0.0.1', port: 8443 }],
    ['[::1]:8443', { host: '::1', port: 8443 }],
    ['edge.example:443', { host: 'edge.example', port: 443 }],
    ['no-port', undefined],
    ['', undefined],
    [undefined, undefined],
  ])('%j → %j', (value, expected) => expect(parseEdgeAddress(value)).toEqual(expected))
})

describe('wireRemoteAccess', () => {
  it('uses what a test hands it, untouched', async () => {
    const spawner = () => undefined
    const prober = { verify: async () => true }
    const wired = await wireRemoteAccess({
      ...base(),
      overrides: { spawner, prober, timings: { readyMs: 5 } },
    })
    expect(wired.spawner).toBe(spawner)
    expect(wired.prober).toBe(prober)
    expect(wired.timings).toEqual({ readyMs: 5 })
  })

  it("reports an installation without the binary through the owner's warnings, and sets no timings of its own", async () => {
    const warnings: string[] = []
    const wired = await wireRemoteAccess({ ...base(warnings), resourcesDir: join(dir, 'resources') })
    expect(wired.timings).toBeUndefined()
    expect(await wired.spawner('http://127.0.0.1:1337')).toBeUndefined()
    expect(warnings).toEqual(['remote access: no cloudflared binary was found for this installation'])
  })

  it("journals under the owner's instance, at the path it was given", async () => {
    const wired = await wireRemoteAccess(base())
    await wired.journal?.record(4242, '/app/cloudflared')
    expect(JSON.parse(await readFile(join(dir, 'remote-access-tunnel.json'), 'utf8'))).toMatchObject({
      pid: 4242,
      instance_id: 'instance-1',
      exe: '/app/cloudflared',
    })
    await wired.journal?.clear()
  })

  it('proves a URL through the stand-in edge and its certificate when the test hooks name them', async () => {
    const hosts: Array<string | undefined> = []
    const edge = createTlsServer(
      { key: tlsFixture('tunnel.key'), cert: tlsFixture('tunnel.pem') },
      (req, res) => {
        hosts.push(req.headers.host)
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ info: { title: PROBE_MARKER } }))
      }
    )
    await new Promise<void>((resolve) => edge.listen(0, '127.0.0.1', resolve))
    try {
      const tlsDir = fileURLToPath(new URL('../../test/fixtures/tls/', import.meta.url))
      const wired = await wireRemoteAccess({
        ...base(),
        env: {
          [REMOTE_ACCESS_EDGE_ENV]: `127.0.0.1:${(edge.address() as AddressInfo).port}`,
          [REMOTE_ACCESS_CA_ENV]: join(tlsDir, 'tunnel.pem'),
        },
      })
      expect(await wired.prober.verify('https://calm-river-demo.trycloudflare.com', 3000)).toBe(true)
      expect(hosts).toEqual(['calm-river-demo.trycloudflare.com'])
    } finally {
      await new Promise((resolve) => edge.close(resolve))
    }
  })
})
