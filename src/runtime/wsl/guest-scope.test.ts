import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WslDistributionTransport, WslExecOptions } from './transport.js'
import { ensureGuestScope, guestScopeKeyReader, readOrCreateGuestScopeKey } from './guest-scope.js'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'guest-scope-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('readOrCreateGuestScopeKey', () => {
  it('creates the key once and reads the same one back, so a moved data folder keeps its guest folder', async () => {
    const file = join(dir, 'managed-runtimes', 'guest-scope.json')
    const first = await readOrCreateGuestScopeKey(file, () => 'k-0001')
    const again = await readOrCreateGuestScopeKey(file, () => 'k-0002')
    expect(first).toBe('k-0001')
    expect(again).toBe('k-0001')
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ schema_version: 1, scope_key: 'k-0001' })
  })

  it('refuses a key that is not one core would make, rather than using it as a path', async () => {
    const file = join(dir, 'guest-scope.json')
    await writeFile(file, JSON.stringify({ schema_version: 1, scope_key: '../../etc' }))
    await expect(readOrCreateGuestScopeKey(file, () => 'k')).rejects.toMatchObject({
      code: 'MANAGED_METADATA_INVALID',
    })
  })
})

describe('ensureGuestScope', () => {
  it('creates the scope’s folders in the guest as root and gives them to uid 1000, the container’s user', async () => {
    const calls: { argv: string[]; options: WslExecOptions }[] = []
    const transport: WslDistributionTransport = {
      name: 'AtomicChat',
      exec: async (argv, options = {}) => {
        calls.push({ argv, options })
        return { code: 0, stdout: '', stderr: '' }
      },
      hold: () => {
        throw new Error('no hold')
      },
    }
    await ensureGuestScope(transport, 'k1')
    const root = '/var/lib/atomic-chat/scopes/k1'
    expect(calls.map((call) => call.argv)).toEqual([
      [
        'mkdir',
        '-p',
        `${root}/models/tensorrt-llm`,
        `${root}/caches`,
        `${root}/heartbeats`,
        `${root}/watchdog`,
      ],
      [
        'chown',
        '1000:1000',
        root,
        `${root}/models`,
        `${root}/models/tensorrt-llm`,
        `${root}/caches`,
        `${root}/heartbeats`,
        `${root}/watchdog`,
      ],
    ])
    expect(calls.every((call) => call.options.user === 'root')).toBe(true)
  })
})

describe('guestScopeKeyReader', () => {
  it('two first callers racing get the same key, created once', async () => {
    const file = join(dir, 'guest-scope.json')
    let made = 0
    const read = guestScopeKeyReader(file, () => `k-000${++made}`)
    const [a, b] = await Promise.all([read(), read()])
    expect(a).toBe('k-0001')
    expect(b).toBe('k-0001')
    expect(made).toBe(1)
  })

  it('a failed read is not remembered: the next call reads again', async () => {
    const file = join(dir, 'guest-scope.json')
    await writeFile(file, 'not json')
    const read = guestScopeKeyReader(file, () => 'k-0001')
    await expect(read()).rejects.toThrow()
    await rm(file)
    expect(await read()).toBe('k-0001')
  })
})
