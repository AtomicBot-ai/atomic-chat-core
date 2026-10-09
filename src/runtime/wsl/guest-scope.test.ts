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
        `${root}/managed-models`,
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
        `${root}/managed-models`,
        `${root}/models/tensorrt-llm`,
        `${root}/caches`,
        `${root}/heartbeats`,
        `${root}/watchdog`,
      ],
      [
        'find',
        `${root}/managed-models`,
        '-mindepth',
        '1',
        '-maxdepth',
        '1',
        '-type',
        'd',
        '-user',
        'root',
        '-exec',
        'chown',
        '1000:1000',
        '{}',
        '+',
      ],
    ])
    expect(calls.every((call) => call.options.user === 'root')).toBe(true)
  })

  it('gives back to uid 1000 the model store and the publisher folders the store migration made as root', async () => {
    // A guest after the migration moved `nvidia/<model>` in as root: the app, writing as uid 1000
    // through \\wsl.localhost, could not create `managed-models/nvidia/<new model>` (os error 5).
    const root = '/var/lib/atomic-chat/scopes/k1'
    const owners = new Map<string, string>([
      [`${root}/managed-models`, 'root'],
      [`${root}/managed-models/nvidia`, 'root'],
      [`${root}/managed-models/nvidia/Qwen3-8B-FP8`, '1000'],
      [`${root}/managed-models/Qwen`, '1000'],
    ])
    const transport: WslDistributionTransport = {
      name: 'AtomicChat',
      exec: async (argv) => {
        if (argv[0] === 'chown') {
          for (const path of argv.slice(2)) if (owners.has(path)) owners.set(path, '1000')
        }
        if (argv[0] === 'find') {
          const store = argv[1] as string
          const hits = [...owners.keys()].filter(
            (path) =>
              path.startsWith(`${store}/`) &&
              !path.slice(store.length + 1).includes('/') &&
              owners.get(path) === 'root'
          )
          for (const path of hits) owners.set(path, '1000')
        }
        return { code: 0, stdout: '', stderr: '' }
      },
      hold: () => {
        throw new Error('no hold')
      },
    }
    await ensureGuestScope(transport, 'k1')
    expect([...owners.values()].every((owner) => owner === '1000')).toBe(true)
  })

  it('a folder it cannot give back fails the preparation with the command and the guest’s reason', async () => {
    const transport: WslDistributionTransport = {
      name: 'AtomicChat',
      exec: async (argv) =>
        argv[0] === 'find'
          ? { code: 1, stdout: '', stderr: 'chown: changing ownership: Operation not permitted' }
          : { code: 0, stdout: '', stderr: '' },
      hold: () => {
        throw new Error('no hold')
      },
    }
    await expect(ensureGuestScope(transport, 'k1')).rejects.toMatchObject({
      code: 'IO_ERROR',
      details: expect.stringContaining('Operation not permitted'),
    })
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
