import { posix, win32 } from 'node:path'
import { AtomicCoreError } from '../../contracts/index.js'
import type { SpawnSpec } from '../shared/index.js'

export interface StrataControlOptions {
  platform: NodeJS.Platform
  bundleDir: string
  python: string
  scopeDir: string
  profile: string
  ownerPid: number
  env: Readonly<Record<string, string | undefined>>
}
export type StrataControlCommand =
  | { kind: 'create'; config: string }
  | { kind: 'start'; waitSeconds: number }
  | { kind: 'status' }
  | { kind: 'stop'; ownerId: string; instanceId?: string }

const identity = /^[a-f0-9]{32}$/
const ownedProfile = /^atomic-[a-f0-9]{32}$/
const invalid = (message: string): never => {
  throw new AtomicCoreError('INVALID_ARGUMENT', message)
}
const bootstrap =
  'import runpy,sys; root=sys.argv.pop(1); sys.path.insert(0,root); sys.path.insert(1,root+"/third_party/llama.cpp/gguf-py"); sys.argv[0]=root+"/strata.py"; runpy.run_path(sys.argv[0],run_name="__main__")'

/** Only fixed Control operations; no shell, updater, downloader or inherited Python configuration. */
export function strataControlPlan(o: StrataControlOptions, command: StrataControlCommand): SpawnSpec {
  const p = o.platform === 'win32' ? win32 : posix
  if (!ownedProfile.test(o.profile) || !Number.isSafeInteger(o.ownerPid) || o.ownerPid <= 0)
    invalid('Invalid Atomic Strata profile or core owner PID.')
  for (const path of [o.bundleDir, o.python, o.scopeDir])
    if (!p.isAbsolute(path) || path.includes('\0')) invalid('Strata runtime paths must be absolute.')
  const pythonRelative = p.relative(o.bundleDir, o.python)
  if (pythonRelative.startsWith('..') || p.isAbsolute(pythonRelative))
    invalid('Strata must use packaged Python.')
  const scope = (name: string) => p.join(o.scopeDir, name)
  const systemRoot = o.env.SystemRoot ?? o.env.SYSTEMROOT ?? 'C:\\Windows'
  const env: Record<string, string> = {
    PATH: o.platform === 'win32' ? p.join(systemRoot, 'System32') : '/usr/bin:/bin',
    HOME: scope('home'),
    USERPROFILE: scope('home'),
    XDG_STATE_HOME: scope('state'),
    XDG_CONFIG_HOME: scope('config'),
    XDG_DATA_HOME: scope('data'),
    XDG_CACHE_HOME: scope('cache'),
    LOCALAPPDATA: scope('local'),
    APPDATA: scope('config'),
    TMPDIR: scope('tmp'),
    TEMP: scope('tmp'),
    TMP: scope('tmp'),
    STRATA_PROFILE_DIR: scope('profiles'),
    STRATA_RUNTIME_DIR: scope('runtime'),
    STRATA_COMPONENTS_DIR: scope('components'),
    STRATA_NO_ACQUIRE: '1',
    STRATA_NO_HANDOVER: '1',
    // The server's legacy orphan scan is executable-wide. Core reconciles only its own journal.
    STRATA_KEEP_LEFTOVERS: '1',
    STRATA_ATOMIC_OWNER: '1',
    STRATA_START_RETRIES: '0',
    PYTHONNOUSERSITE: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONUTF8: '1',
  }
  if (o.platform === 'win32') env.SystemRoot = systemRoot
  let args: string[]
  switch (command.kind) {
    case 'create': {
      const relative = p.relative(o.scopeDir, command.config)
      if (!p.isAbsolute(command.config) || !relative || relative.startsWith('..') || p.isAbsolute(relative))
        invalid('Strata config must belong to this Atomic scope.')
      args = ['profile', 'create', o.profile, '--from-config', command.config]
      break
    }
    case 'start':
      if (!Number.isFinite(command.waitSeconds) || command.waitSeconds < 0 || command.waitSeconds > 60)
        invalid('Invalid Strata command wait budget.')
      args = [
        'runtime',
        'start',
        '--profile',
        o.profile,
        '--die-with-pid',
        String(o.ownerPid),
        '--wait',
        String(command.waitSeconds),
        '--shutdown-timeout',
        '300',
      ]
      break
    case 'status':
      args = ['runtime', 'status', '--profile', o.profile]
      break
    case 'stop':
      if (
        !identity.test(command.ownerId) ||
        (command.instanceId !== undefined && !identity.test(command.instanceId))
      )
        invalid('Stopping Strata requires its recorded owner and instance identity.')
      args = [
        'runtime',
        'stop',
        '--profile',
        o.profile,
        '--wait',
        '330',
        '--if-owner-id',
        command.ownerId,
        ...(command.instanceId ? ['--if-instance-id', command.instanceId] : []),
      ]
  }
  return {
    exe: o.python,
    args: ['-I', '-B', '-c', bootstrap, p.join(o.bundleDir, 'control'), ...args, '--output', 'json'],
    env,
    cwd: p.join(o.bundleDir, 'control'),
    platform: o.platform,
  }
}

export interface StrataControlStatus {
  state: 'starting' | 'ready' | 'stopped' | 'failed' | 'stale'
  ownerId?: string
  instanceId?: string
  hostPid?: number
  childPid?: number
  profileRevision?: string
  error?: string
}

/** CLI success alone is not readiness; a stopped HTTP host is not proof that compute has stopped. */
export function parseStrataControlStatus(
  raw: unknown,
  expected: { profile: string; ownerId?: string; instanceId?: string }
): StrataControlStatus {
  const bad = (): never => {
    throw new AtomicCoreError(
      'MODEL_LOAD_FAILED',
      'Strata returned an invalid or mismatched runtime identity.'
    )
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad()
  const r = raw as Record<string, unknown>
  if (
    typeof r.ok !== 'boolean' ||
    r.profile !== expected.profile ||
    !ownedProfile.test(expected.profile) ||
    !['starting', 'ready', 'stopped', 'failed', 'stale'].includes(String(r.state))
  )
    return bad()
  const result: StrataControlStatus = { state: r.state as StrataControlStatus['state'] }
  for (const [key, wire] of [
    ['ownerId', 'owner_id'],
    ['instanceId', 'instance_id'],
  ] as const) {
    if (r[wire] !== undefined && r[wire] !== null) {
      if (typeof r[wire] !== 'string' || !identity.test(r[wire])) return bad()
      result[key] = r[wire]
    }
    if (
      expected[key] !== undefined &&
      result[key] !== expected[key] &&
      !['stopped', 'stale'].includes(result.state)
    )
      return bad()
  }
  for (const [key, wire] of [
    ['hostPid', 'host_pid'],
    ['childPid', 'child_pid'],
  ] as const) {
    if (r[wire] !== undefined && r[wire] !== null) {
      if (!Number.isSafeInteger(r[wire]) || Number(r[wire]) <= 0) return bad()
      result[key] = r[wire] as number
    }
  }
  if (r.profile_revision !== undefined && r.profile_revision !== null) {
    if (typeof r.profile_revision !== 'string' || !/^[a-f0-9]{16}$/.test(r.profile_revision)) return bad()
    result.profileRevision = r.profile_revision
  }
  if (r.error !== undefined && r.error !== null) {
    if (typeof r.error !== 'string' || r.error.length > 4096) return bad()
    result.error = r.error
  }
  if (
    result.state === 'ready' &&
    (!r.ok ||
      r.model_state !== 'ready' ||
      !result.ownerId ||
      !result.instanceId ||
      !result.hostPid ||
      !result.childPid ||
      !result.profileRevision)
  )
    return bad()
  return result
}
