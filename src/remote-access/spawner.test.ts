import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FAKE_TUNNEL_URL, fakeCloudflaredCommand } from '../../test/helpers/fake-cloudflared.js'
import { spawnTunnel } from './process.js'
import type { TunnelCommand } from './process.js'
import { cloudflaredSpawner, emptyConfigFor } from './spawner.js'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atomic-cloudflared-spawner-'))
})
afterEach(() => rm(dir, { recursive: true, force: true }))

describe('emptyConfigFor', () => {
  it('points at /dev/null where there is one, and writes an empty document on Windows', async () => {
    expect(await emptyConfigFor('darwin', join(dir, 'unused.yml'))).toBe('/dev/null')
    expect(await emptyConfigFor('linux', join(dir, 'unused.yml'))).toBe('/dev/null')
    const path = join(dir, 'atomic-core', 'cloudflared-empty.yml')
    expect(await emptyConfigFor('win32', path)).toBe(path)
    expect(await readFile(path, 'utf8')).toBe('')
  })

  it('does without it when the document cannot be written', async () => {
    // A file where its folder should be: no folder can be made there on any OS.
    const blocker = join(dir, 'blocker')
    await writeFile(blocker, '')
    expect(await emptyConfigFor('win32', join(blocker, 'nested', 'empty.yml'))).toBeUndefined()
  })
})

describe('cloudflaredSpawner', () => {
  it('answers nothing, and says why, when the installation carries no binary', async () => {
    const messages: string[] = []
    const spawner = cloudflaredSpawner({
      env: {},
      platform: 'darwin',
      emptyConfigPath: join(dir, 'empty.yml'),
      exists: () => false,
      resourcesDir: '/app/resources/bin',
      log: (message) => messages.push(message),
    })
    expect(await spawner('http://127.0.0.1:1337')).toBeUndefined()
    expect(messages).toEqual(['remote access: no cloudflared binary was found for this installation'])
  })

  it("launches the binary it found with the quick-tunnel command line and none of the user's TUNNEL_* variables", async () => {
    const launched: TunnelCommand[] = []
    const spawner = cloudflaredSpawner({
      explicit: '/named/cloudflared',
      env: { PATH: '/usr/bin', TUNNEL_TOKEN: 'someone-elses' },
      platform: 'linux',
      emptyConfigPath: join(dir, 'empty.yml'),
      exists: (path) => path === '/named/cloudflared',
      launch: (command, platform) => {
        launched.push(command)
        // Run the fake in place of the resolved binary; everything after the launch is production.
        return spawnTunnel(
          fakeCloudflaredCommand(command.args, { mode: 'registers-only-on-http2' }),
          platform
        )
      },
    })
    const tunnel = await spawner('http://127.0.0.1:1337', 'http2')
    try {
      expect(launched).toEqual([
        {
          program: '/named/cloudflared',
          args: [
            'tunnel',
            '--config',
            '/dev/null',
            '--url',
            'http://127.0.0.1:1337',
            '--no-autoupdate',
            '--protocol',
            'http2',
          ],
          env: { PATH: '/usr/bin' },
        },
      ])
      expect(await tunnel?.waitReady(10_000)).toEqual({ kind: 'url', url: FAKE_TUNNEL_URL })
    } finally {
      tunnel?.killNow()
    }
  })

  it('starts the real file when nothing stands in for it, and reports one that cannot run', async () => {
    const spawner = cloudflaredSpawner({
      explicit: join(dir, 'cloudflared'),
      env: {},
      platform: process.platform,
      emptyConfigPath: join(dir, 'empty.yml'),
      exists: () => true,
    })
    const tunnel = await spawner('http://127.0.0.1:1337')
    expect(tunnel?.exe).toBe(join(dir, 'cloudflared'))
    expect(await tunnel?.waitReady(5000)).toEqual({ kind: 'spawn-failed' })
  })
})
