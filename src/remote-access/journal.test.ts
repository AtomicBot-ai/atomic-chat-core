import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TUNNEL_JOURNAL_FILE, TunnelJournal, isTunnelName, reapTunnelOrphan } from './journal.js'
import type { ReapDeps } from './journal.js'

let dir: string
let path: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atomic-tunnel-journal-'))
  path = join(dir, TUNNEL_JOURNAL_FILE)
})
afterEach(() => rm(dir, { recursive: true, force: true }))

const read = async () => JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
const exists = () =>
  readFile(path).then(
    () => true,
    () => false
  )

describe('isTunnelName', () => {
  it.each([
    ['cloudflared', true],
    ['Cloudflared', true],
    ['cloudflared-x86_64', true],
    ['  cloudflared ', true],
    ['node', false],
    ['llama-server', false],
    ['not-cloudflared', false],
    ['', false],
    [undefined, false],
  ])('%j → %s', (name, expected) => expect(isTunnelName(name)).toBe(expected))
})

describe('TunnelJournal', () => {
  it('records the tunnel at once, then again with its start identity', async () => {
    let releaseIdentity!: (id: string) => void
    const identity = new Promise<string>((resolve) => (releaseIdentity = resolve))
    const journal = new TunnelJournal(path, 'instance-1', {
      startId: () => identity,
      now: () => 1_700_000_000_500,
    })
    const recorded = journal.record(4242, '/app/cloudflared')
    // The identity probe has not answered: the trail is already there.
    await expect.poll(exists).toBe(true)
    expect(await read()).toEqual({
      pid: 4242,
      process_start_id: null,
      started_at_secs: 1_700_000_000,
      instance_id: 'instance-1',
      exe: '/app/cloudflared',
    })
    releaseIdentity('darwin:Thu Sep 17 10:00:00 2026')
    await recorded
    expect(await read()).toMatchObject({ pid: 4242, process_start_id: 'darwin:Thu Sep 17 10:00:00 2026' })
    expect(await exists()).toBe(true)
    await journal.clear()
    expect(await exists()).toBe(false)
  })

  it('keeps the record without an identity when the platform cannot give one', async () => {
    const journal = new TunnelJournal(path, 'i', { startId: async () => undefined })
    await journal.record(7, 'x')
    expect(await read()).toMatchObject({ pid: 7, process_start_id: null })
  })

  it('never resurrects a record that was cleared while the identity probe was running', async () => {
    let releaseIdentity!: (id: string) => void
    const journal = new TunnelJournal(path, 'i', {
      startId: () => new Promise((resolve) => (releaseIdentity = resolve)),
    })
    const recorded = journal.record(7, 'x')
    await expect.poll(exists).toBe(true)
    const cleared = journal.clear()
    releaseIdentity('late')
    await recorded
    await cleared
    expect(await exists()).toBe(false)
  })

  it('costs crash recovery, never the tunnel, when the journal cannot be written', async () => {
    const warnings: string[] = []
    const journal = new TunnelJournal(join(dir, 'missing-folder', TUNNEL_JOURNAL_FILE), 'i', {
      log: (message) => warnings.push(message),
    })
    await expect(journal.record(7, 'x')).resolves.toBeUndefined()
    expect(warnings).toHaveLength(1)
  })
})

// The six tests of the app's `journal.rs`, plus the identity fallback the core adds.
describe('reapTunnelOrphan', () => {
  const entry = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      pid: 4242,
      process_start_id: 'id-1',
      started_at_secs: 1000,
      instance_id: 'old',
      exe: 'x',
      ...over,
    })
  const tunnel = {
    alive: () => true,
    name: async () => 'cloudflared',
    verifyIdentity: async () => 'match' as const,
  }

  it('does nothing when there is no journal', async () => {
    expect(await reapTunnelOrphan(path)).toBe('none')
  })

  it('ends the recorded tunnel and never reads the journal twice', async () => {
    await writeFile(path, entry())
    const killed: number[] = []
    expect(await reapTunnelOrphan(path, { ...tunnel, kill: (pid) => killed.push(pid) })).toBe('killed')
    expect(killed).toEqual([4242])
    expect(await exists()).toBe(false)
    expect(await reapTunnelOrphan(path, { ...tunnel, kill: (pid) => killed.push(pid) })).toBe('none')
  })

  it("never touches a process that only looks like ours: the user's own cloudflared under a reused pid", async () => {
    await writeFile(path, entry())
    const killed: number[] = []
    const outcome = await reapTunnelOrphan(path, {
      ...tunnel,
      verifyIdentity: async () => 'mismatch',
      kill: (pid) => killed.push(pid),
    })
    expect(outcome).toBe('spared')
    expect(killed).toEqual([])
    expect(await exists()).toBe(false)
  })

  it('never touches a process whose name is not the tunnel, even with a matching identity', async () => {
    await writeFile(path, entry())
    const killed: number[] = []
    expect(
      await reapTunnelOrphan(path, { ...tunnel, name: async () => 'node', kill: (pid) => killed.push(pid) })
    ).toBe('spared')
    expect(
      await reapTunnelOrphan(path, {
        ...tunnel,
        name: async () => undefined,
        kill: (pid) => killed.push(pid),
      })
    ).toBe('none')
    expect(killed).toEqual([])
  })

  it('spares a process it cannot prove is the recorded one', async () => {
    await writeFile(path, entry())
    expect(
      await reapTunnelOrphan(path, { ...tunnel, verifyIdentity: async () => 'unknown', kill: () => {} })
    ).toBe('spared')
  })

  it('falls back to the start time when the crash came before the identity was recorded', async () => {
    const killed: number[] = []
    await writeFile(path, entry({ process_start_id: null, started_at_secs: 1000 }))
    expect(
      await reapTunnelOrphan(path, {
        ...tunnel,
        startEpoch: async () => 'epoch:1003',
        kill: (pid) => killed.push(pid),
      })
    ).toBe('killed')
    await writeFile(path, entry({ process_start_id: null, started_at_secs: 1000 }))
    expect(
      await reapTunnelOrphan(path, {
        ...tunnel,
        startEpoch: async () => 'epoch:1600',
        kill: (pid) => killed.push(pid),
      })
    ).toBe('spared')
    await writeFile(path, entry({ process_start_id: null, started_at_secs: 1000 }))
    expect(
      await reapTunnelOrphan(path, {
        ...tunnel,
        startEpoch: async () => undefined,
        kill: (pid) => killed.push(pid),
      })
    ).toBe('spared')
    expect(killed).toEqual([4242])
  })

  it('ignores a record of a process that is gone, of this very process, or that cannot be parsed', async () => {
    await writeFile(path, entry())
    expect(await reapTunnelOrphan(path, { ...tunnel, alive: () => false })).toBe('gone')
    await writeFile(path, entry({ pid: process.pid }))
    expect(await reapTunnelOrphan(path, tunnel)).toBe('gone')
    for (const broken of [
      '{ not json',
      'null',
      JSON.stringify({ pid: 'seven' }),
      JSON.stringify({ pid: -1 }),
    ]) {
      await writeFile(path, broken)
      const warnings: string[] = []
      expect(await reapTunnelOrphan(path, { ...tunnel, log: (m) => warnings.push(m) })).toBe('none')
      expect(warnings).toEqual(['ignoring an unreadable remote-access journal'])
      expect(await exists()).toBe(false)
    }
  })

  it('reports a process that ended between the checks and the kill as gone', async () => {
    await writeFile(path, entry())
    expect(
      await reapTunnelOrphan(path, {
        ...tunnel,
        kill: () => {
          throw new Error('ESRCH')
        },
      })
    ).toBe('gone')
  })

  it.skipIf(process.platform === 'win32')(
    'really ends a recorded child, with only its name stood in for',
    async () => {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
      await new Promise((resolve) => child.once('spawn', resolve))
      const journal = new TunnelJournal(path, 'previous-owner')
      await journal.record(child.pid as number, process.execPath)
      expect((await read())['process_start_id']).toEqual(expect.any(String))
      const exited = new Promise((resolve) => child.once('exit', resolve))
      // The real identity check against the real process; a Node child is of course not named cloudflared.
      expect(await reapTunnelOrphan(path, { name: async () => 'cloudflared' })).toBe('killed')
      await exited
      expect(child.signalCode).toBe('SIGKILL')
    }
  )

  it.skipIf(process.platform === 'win32')(
    'leaves a recorded child alone when it is not a tunnel by name',
    async () => {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
      await new Promise((resolve) => child.once('spawn', resolve))
      try {
        await new TunnelJournal(path, 'previous-owner').record(child.pid as number, process.execPath)
        expect(await reapTunnelOrphan(path)).toBe('spared')
        expect(child.exitCode).toBeNull()
      } finally {
        child.kill('SIGKILL')
      }
    }
  )
})

// Atomic Chat 2.0.40's `journal.rs` (tag `v2.0.40`) wrote `<data>/remote-access-tunnel.json` as serde's
// compact `{pid, started_at_secs}`; startup reaps it with the same checks as the core's own journal.
describe('reapTunnelOrphan on the journal of Atomic Chat 2.0.40', () => {
  const legacy = '{"pid":4242,"started_at_secs":1000}'
  const tunnel = {
    alive: () => true,
    name: async () => 'cloudflared.exe',
    // The entry carries no start identity: only the start time may decide.
    verifyIdentity: async (): Promise<'match'> => {
      throw new Error('a 2.0.40 entry has no start identity to verify')
    },
  }

  it('ends the tunnel it describes and removes the file', async () => {
    await writeFile(path, legacy)
    const killed: number[] = []
    expect(
      await reapTunnelOrphan(path, {
        ...tunnel,
        startEpoch: async () => 'epoch:998',
        kill: (pid) => killed.push(pid),
      })
    ).toBe('killed')
    expect(killed).toEqual([4242])
    expect(await exists()).toBe(false)
  })

  it('leaves alone a process it cannot prove is that tunnel, and still removes the file', async () => {
    const killed: number[] = []
    const kill = (pid: number) => void killed.push(pid)
    const cases: Array<[string, ReapDeps]> = [
      // The user's own cloudflared under a reused pid, started an hour later.
      [legacy, { startEpoch: async () => 'epoch:4600' }],
      // The recorded start time, but another program.
      [legacy, { name: async () => 'postgres', startEpoch: async () => 'epoch:1000' }],
      // No start time to compare with.
      [legacy, { startEpoch: async () => undefined }],
      // An entry without its start time.
      ['{"pid":4242}', { startEpoch: async () => 'epoch:1000' }],
    ]
    for (const [text, deps] of cases) {
      await writeFile(path, text)
      expect(await reapTunnelOrphan(path, { ...tunnel, ...deps, kill })).toBe('spared')
      expect(await exists()).toBe(false)
    }
    expect(killed).toEqual([])
  })

  it('ignores an absent or unreadable file, and removes the unreadable one', async () => {
    const killed: number[] = []
    const kill = (pid: number) => void killed.push(pid)
    expect(await reapTunnelOrphan(path, { ...tunnel, kill })).toBe('none')
    for (const broken of ['', '{ not json', '{"pid":4242,"started_at', '{"pid":0,"started_at_secs":1000}']) {
      await writeFile(path, broken)
      expect(await reapTunnelOrphan(path, { ...tunnel, kill })).toBe('none')
      expect(await exists()).toBe(false)
    }
    expect(killed).toEqual([])
  })
})
