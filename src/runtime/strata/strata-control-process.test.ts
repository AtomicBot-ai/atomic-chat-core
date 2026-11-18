import type { SpawnSpec } from '../shared/index.js'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { StrataControlProcess } from './strata-control-process.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })))
})
const profile = 'atomic-' + 'a'.repeat(32)
async function options() {
  const root = await mkdtemp(join(tmpdir(), 'strata-control-'))
  roots.push(root)
  return {
    platform: process.platform,
    bundleDir: root,
    python: join(root, 'python'),
    scopeDir: join(root, 'scope'),
    ownerPid: process.pid,
    profile,
    env: {},
  }
}
function openControl(
  options: Parameters<typeof StrataControlProcess.open>[0],
  run: NonNullable<Parameters<typeof StrataControlProcess.open>[1]>
) {
  return StrataControlProcess.open(options, (spec, timeout, start) =>
    spec.args[3]?.includes('private_files.restrict_to_current_user')
      ? Promise.resolve({ code: 0, stdout: '' })
      : run(spec, timeout, start)
  )
}
it('accepts the bounded start wait expiry but never treats command completion as ready', async () => {
  const run = vi.fn(async () => ({
    code: 8,
    stdout: JSON.stringify({ ok: false, profile, state: 'starting', error: 'startup_wait_expired' }),
  }))
  const control = await openControl(await options(), run)
  expect((await control.start()).state).toBe('starting')
  expect(run.mock.calls).toHaveLength(1)
})
it('refuses redirected private state before invoking Python', async () => {
  const o = await options()
  await mkdir(o.scopeDir, { mode: 0o700 })
  await mkdir(join(o.bundleDir, 'foreign'))
  await symlink(
    join(o.bundleDir, 'foreign'),
    join(o.scopeDir, 'profiles'),
    process.platform === 'win32' ? 'junction' : 'dir'
  )
  const run = vi.fn()
  await expect(openControl(o, run)).rejects.toThrow(/private|redirect/i)
  expect(run).not.toHaveBeenCalled()
})
it('does not accept a failed command with a success-shaped payload, or signal another owner', async () => {
  const run = vi.fn(async () => ({
    code: 1,
    stdout: JSON.stringify({ ok: true, profile, state: 'stopped' }),
  }))
  const control = await openControl(await options(), run)
  await expect(control.status()).rejects.toThrow()
  run.mockResolvedValueOnce({
    code: 0,
    stdout: JSON.stringify({ ok: true, profile, state: 'starting', owner_id: 'b'.repeat(32) }),
  })
  await expect(control.status({ ownerId: 'c'.repeat(32) })).rejects.toThrow(/identity/i)
})
it('parses private profile creation and preserves explicit stop identity', async () => {
  const o = await options()
  const run = vi.fn(async () => ({
    code: 0,
    stdout: JSON.stringify({ ok: true, profile, revision: 'd'.repeat(16) }),
  }))
  const control = await openControl(o, run)
  await writeFile(join(o.scopeDir, 'config.json'), '{}', { mode: 0o600 })
  await expect(control.create(join(o.scopeDir, 'config.json'))).resolves.toBeUndefined()
  // Pinned Control's successful live stop uses null for its error field.
  run.mockResolvedValueOnce({
    code: 0,
    stdout: JSON.stringify({ ok: true, profile, state: 'stopped', error: null }),
  })
  expect((await control.stop({ ownerId: 'b'.repeat(32), instanceId: 'c'.repeat(32) })).state).toBe('stopped')
})

it('requires a start command to wait for the durable launcher registration', async () => {
  const register = vi.fn(async (_pid: number) => {})
  const run = vi.fn(
    async (spec: SpawnSpec, timeout: number, start?: { register: (pid: number) => Promise<void> }) => {
      expect(spec.args[3]).toContain('sys.stdin.read(1)')
      expect(timeout).toBe(90_000)
      await start!.register(123)
      return { code: 0, stdout: JSON.stringify({ ok: true, profile, state: 'starting' }) }
    }
  )
  const control = await openControl(await options(), run)
  await expect(control.start({ register, timeoutMs: 90_000 })).resolves.toMatchObject({ state: 'starting' })
  expect(register).toHaveBeenCalledWith(123)
})

it('retains the verified owner identity on a failed status so the caller can stop it', async () => {
  const run = vi.fn(async () => ({
    code: 6,
    stdout: JSON.stringify({
      ok: false,
      profile,
      state: 'failed',
      owner_id: 'a'.repeat(32),
      host_pid: 42,
      error: 'server_exited',
    }),
  }))
  const control = await openControl(await options(), run)
  await expect(control.status()).resolves.toMatchObject({
    state: 'failed',
    ownerId: 'a'.repeat(32),
    hostPid: 42,
  })
})
