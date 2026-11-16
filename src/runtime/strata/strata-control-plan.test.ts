import { expect, it } from 'vitest'
import { strataControlPlan, parseStrataControlStatus } from './strata-control-plan.js'

const profile = 'atomic-' + 'a'.repeat(32)
const owner = 'b'.repeat(32)
const instance = 'c'.repeat(32)
const options = {
  platform: 'darwin' as const,
  bundleDir: '/bundle',
  python: '/bundle/python/bin/python3',
  scopeDir: '/data/atomic-core/strata/scope',
  ownerPid: 123,
  profile,
  env: {
    HOME: '/foreign',
    PYTHONPATH: '/evil',
    PYTHONHOME: '/evil',
    STRATA_RUNTIME_DIR: '/foreign',
    PATH: '/evil',
    HF_TOKEN: 'secret',
    DYLD_INSERT_LIBRARIES: '/evil',
  },
}
it('isolates Control state and imports from poisoned parent settings', () => {
  const p = strataControlPlan(options, { kind: 'start', waitSeconds: 1 })
  expect(p.exe).toBe('/bundle/python/bin/python3')
  expect(p.args.slice(0, 3)).toEqual(['-I', '-B', '-c'])
  expect(p.args.slice(-10)).toEqual([
    '--profile',
    profile,
    '--die-with-pid',
    '123',
    '--wait',
    '1',
    '--shutdown-timeout',
    '300',
    '--output',
    'json',
  ])
  expect(p.env).toMatchObject({
    STRATA_NO_ACQUIRE: '1',
    STRATA_NO_HANDOVER: '1',
    STRATA_KEEP_LEFTOVERS: '1',
    STRATA_ATOMIC_OWNER: '1',
    STRATA_RUNTIME_DIR: options.scopeDir + '/runtime',
    STRATA_PROFILE_DIR: options.scopeDir + '/profiles',
    XDG_STATE_HOME: options.scopeDir + '/state',
    HOME: options.scopeDir + '/home',
  })
  for (const key of ['PYTHONPATH', 'PYTHONHOME', 'HF_TOKEN', 'DYLD_INSERT_LIBRARIES'])
    expect(p.env).not.toHaveProperty(key)
  expect(p.env.PATH).toBe('/usr/bin:/bin')
})
it('uses Windows private roots without inheriting the user component installation', () => {
  const p = strataControlPlan(
    {
      ...options,
      platform: 'win32',
      bundleDir: 'C:\\bundle',
      python: 'C:\\bundle\\python\\python.exe',
      scopeDir: 'C:\\data\\strata',
      env: { SystemRoot: 'C:\\Windows', LOCALAPPDATA: 'C:\\foreign', APPDATA: 'C:\\foreign' },
    },
    { kind: 'status' }
  )
  expect(p.env).toMatchObject({
    LOCALAPPDATA: 'C:\\data\\strata\\local',
    APPDATA: 'C:\\data\\strata\\config',
    SystemRoot: 'C:\\Windows',
    STRATA_COMPONENTS_DIR: 'C:\\data\\strata\\components',
  })
})
it('guards stop with both identities and refuses a foreign profile or invalid owner pid', () => {
  expect(
    strataControlPlan(options, { kind: 'stop', ownerId: owner, instanceId: instance }).args.slice(-8)
  ).toEqual(['--wait', '330', '--if-owner-id', owner, '--if-instance-id', instance, '--output', 'json'])
  expect(() => strataControlPlan({ ...options, profile: 'user' }, { kind: 'status' })).toThrow()
  expect(() => strataControlPlan({ ...options, ownerPid: 0 }, { kind: 'start', waitSeconds: 1 })).toThrow()
  expect(() => strataControlPlan(options, { kind: 'stop', ownerId: '', instanceId: instance })).toThrow()
})
it('keeps startup wait expiry pending and rejects stale identities before readiness', () => {
  const pending = {
    ok: false,
    state: 'starting',
    profile,
    owner_id: owner,
    host_pid: 44,
    child_pid: 45,
    profile_revision: 'd'.repeat(16),
    error: 'startup_wait_expired',
  }
  expect(parseStrataControlStatus(pending, { profile, ownerId: owner })).toMatchObject({
    state: 'starting',
    ownerId: owner,
    error: 'startup_wait_expired',
  })
  const ready = {
    ...pending,
    ok: true,
    error: undefined,
    state: 'ready',
    instance_id: instance,
    model_state: 'ready',
  }
  expect(parseStrataControlStatus(ready, { profile, ownerId: owner, instanceId: instance }).state).toBe(
    'ready'
  )
  expect(() => parseStrataControlStatus(ready, { profile, ownerId: 'e'.repeat(32) })).toThrow()
  expect(() => parseStrataControlStatus({ ...ready, profile: 'foreign' }, { profile })).toThrow()
  expect(() => parseStrataControlStatus({ ...ready, model_state: 'unloaded' }, { profile })).toThrow()
  expect(() => parseStrataControlStatus({ ...ready, child_pid: null }, { profile })).toThrow()
  expect(
    parseStrataControlStatus({ ok: false, state: 'stale', profile, error: 'owner_host_lost' }, { profile })
      .state
  ).toBe('stale')
})

it('accepts an owner that has not yet attached a profile revision while preparing', () => {
  expect(
    parseStrataControlStatus(
      {
        ok: true,
        state: 'starting',
        profile,
        owner_id: owner,
        host_pid: 44,
        child_pid: null,
        profile_revision: null,
      },
      { profile }
    )
  ).toMatchObject({ state: 'starting', ownerId: owner, hostPid: 44 })
})
