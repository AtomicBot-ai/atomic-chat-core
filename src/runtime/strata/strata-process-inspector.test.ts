import type { SpawnSpec } from '../shared/index.js'
import { expect, it, vi } from 'vitest'
import { StrataProcessInspector } from './strata-process-inspector.js'
const options = {
  platform: 'darwin' as const,
  bundleDir: '/bundle',
  python: '/bundle/control/python/bin/python3',
  scopeDir: '/scope',
  profile: 'atomic-' + 'a'.repeat(32),
  ownerPid: 100,
  env: { PYTHONPATH: '/poison', STRATA_ATOMIC_OWNER: '0' },
}
it('uses only the packaged inspector in its private scope and requires a matching profile', async () => {
  const run = vi.fn(async (_spec: SpawnSpec) =>
    JSON.stringify({ profile: options.profile, processes: [], launchComplete: true })
  )
  const inspector = new StrataProcessInspector(options, run)
  await expect(inspector.snapshot()).resolves.toEqual({ processes: [], launchComplete: true })
  expect(run.mock.calls[0]![0]).toMatchObject({ exe: options.python, env: { STRATA_ATOMIC_OWNER: '1' } })
  expect(run.mock.calls[0]![0].env).not.toHaveProperty('PYTHONPATH')
  run.mockResolvedValueOnce(JSON.stringify({ profile: 'foreign', processes: [], launchComplete: true }))
  await expect(inspector.snapshot()).rejects.toThrow(/identity|scope/i)
})
it('never interprets missing or malformed process evidence as a completed launch', async () => {
  const run = vi.fn(async (_spec: SpawnSpec) =>
    JSON.stringify({ profile: options.profile, processes: [], launchComplete: 'true' })
  )
  const inspector = new StrataProcessInspector(options, run)
  await expect(inspector.snapshot()).rejects.toThrow()
  run.mockResolvedValueOnce(
    JSON.stringify({
      profile: options.profile,
      processes: [{ role: 'compute', pid: 0, startId: null }],
      launchComplete: true,
    })
  )
  await expect(inspector.snapshot()).rejects.toThrow()
  run.mockResolvedValueOnce('not json')
  await expect(inspector.snapshot()).rejects.toThrow()
})
it('validates process identity and passes explicit PID/token to scoped termination', async () => {
  const run = vi.fn(async (_spec: SpawnSpec) =>
    JSON.stringify({ profile: options.profile, startId: 'strata:l:123' })
  )
  const inspector = new StrataProcessInspector(options, run)
  await expect(inspector.identify(123)).resolves.toBe('strata:l:123')
  run.mockResolvedValueOnce(JSON.stringify({ profile: options.profile, verdict: 'unknown' }))
  await expect(inspector.verify(123, 'strata:l:123')).resolves.toBe('unknown')
  run.mockResolvedValueOnce(JSON.stringify({ profile: options.profile, verdict: 'dead' }))
  await expect(inspector.terminate(123, 'strata:l:123')).resolves.toBe('dead')
  expect(run.mock.calls.at(-1)![0].args.slice(-3)).toEqual(['terminate', '123', 'strata:l:123'])
  await expect(inspector.terminate(0, 'strata:l:123')).rejects.toThrow()
})
