import { execFile } from 'node:child_process'
import { lstat, mkdir, realpath } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { AtomicCoreError } from '../../contracts/index.js'
import type { SpawnSpec } from '../shared/index.js'
import { parseStrataControlStatus, strataControlPlan } from './strata-control-plan.js'
import type {
  StrataControlCommand,
  StrataControlOptions,
  StrataControlStatus,
} from './strata-control-plan.js'

interface StartOptions {
  register: (pid: number) => Promise<void>
  timeoutMs: number
  signal?: AbortSignal
}
type Run = (
  spec: SpawnSpec,
  timeoutMs: number,
  start?: StartOptions
) => Promise<{ code: number; stdout: string }>
const privateWindowsScope = `
import sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from strata_control import private_files
for value in sys.argv[2:]:
    path = Path(value)
    private_files.restrict_to_current_user(path, directory=True)
    if not private_files.is_private(path):
        raise OSError("Strata scope is not private")
`
const execute: Run = (spec, timeoutMs, start) =>
  new Promise((resolve, reject) => {
    let registration: Promise<void> = Promise.resolve()
    const child = execFile(
      spec.exe,
      spec.args,
      {
        env: spec.env,
        cwd: spec.cwd,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        killSignal: 'SIGKILL',
        ...(start?.signal ? { signal: start.signal } : {}),
      },
      (error, stdout) => {
        void registration.then(() => {
          if (error && (error.killed || typeof error.code !== 'number')) {
            reject(
              new AtomicCoreError(
                'IO_ERROR',
                'Strata Control command did not complete; runtime stop is not confirmed.'
              )
            )
            return
          }
          resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout })
        }, reject)
      }
    )
    if (start && child.pid !== undefined) {
      const pid = child.pid
      child.stdin?.on('error', () => {})
      registration = Promise.resolve().then(() => start.register(pid))
      void registration.then(
        () => child.stdin?.end('g'),
        () => child.stdin?.end()
      )
    }
  })

/** Executes fixed, scoped commands. The caller must separately confirm the compute tree and HTTP readiness. */
export class StrataControlProcess {
  private constructor(
    private readonly options: StrataControlOptions,
    private readonly run: Run
  ) {}

  static async open(options: StrataControlOptions, run: Run = execute): Promise<StrataControlProcess> {
    strataControlPlan(options, { kind: 'status' })
    await mkdir(dirname(options.scopeDir), { recursive: true, mode: 0o700 })
    const parent = await realpath(dirname(options.scopeDir))
    await mkdir(options.scopeDir, { recursive: true, mode: 0o700 })
    const scopeStat = await lstat(options.scopeDir)
    if (
      !scopeStat.isDirectory() ||
      (options.platform !== 'win32' && (scopeStat.mode & 0o077) !== 0) ||
      relative(parent, await realpath(options.scopeDir)) !==
        relative(dirname(options.scopeDir), options.scopeDir)
    )
      throw new AtomicCoreError('IO_ERROR', 'Strata private scope is redirected.')
    const root = await realpath(options.scopeDir)
    const children = [
      'home',
      'state',
      'config',
      'data',
      'cache',
      'local',
      'tmp',
      'profiles',
      'runtime',
      'components',
    ]
    for (const name of children) {
      const path = join(root, name)
      await mkdir(path, { recursive: true, mode: 0o700 })
      const stat = await lstat(path)
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        (await realpath(path)) !== path ||
        (options.platform !== 'win32' && (stat.mode & 0o077) !== 0)
      )
        throw new AtomicCoreError(
          'IO_ERROR',
          'Strata private state is redirected or accessible to other users.'
        )
    }
    if (options.platform === 'win32') {
      const spec = strataControlPlan({ ...options, scopeDir: root }, { kind: 'status' })
      const result = await run(
        {
          ...spec,
          args: [
            '-I',
            '-B',
            '-c',
            privateWindowsScope,
            spec.cwd!,
            root,
            ...children.map((name) => join(root, name)),
          ],
        },
        30_000
      )
      if (result.code !== 0) throw new AtomicCoreError('IO_ERROR', 'Cannot secure the Strata private scope.')
    }
    return new StrataControlProcess({ ...options, scopeDir: root }, run)
  }

  async create(config: string): Promise<void> {
    const stat = await lstat(config)
    if (!stat.isFile() || (this.options.platform !== 'win32' && (stat.mode & 0o077) !== 0))
      throw new AtomicCoreError('IO_ERROR', 'Strata config must be a private regular file.')
    const r = await this.command({ kind: 'create', config: await realpath(config) })
    if (r.ok !== true)
      throw new AtomicCoreError('MODEL_LOAD_FAILED', 'Strata could not create the private runtime profile.')
  }

  async start(options?: StartOptions): Promise<StrataControlStatus> {
    // Do not spend the model-load budget inside a CLI waiter. One owner is observed by status polling.
    return parseStrataControlStatus(await this.command({ kind: 'start', waitSeconds: 0 }, options), {
      profile: this.options.profile,
    })
  }

  async status(expected: { ownerId?: string; instanceId?: string } = {}): Promise<StrataControlStatus> {
    return parseStrataControlStatus(await this.command({ kind: 'status' }), {
      profile: this.options.profile,
      ...expected,
    })
  }

  async stop(expected: { ownerId: string; instanceId?: string }): Promise<StrataControlStatus> {
    return parseStrataControlStatus(await this.command({ kind: 'stop', ...expected }), {
      profile: this.options.profile,
      ...expected,
    })
  }

  private async command(
    command: StrataControlCommand,
    start?: StartOptions
  ): Promise<Record<string, unknown>> {
    const spec = strataControlPlan(this.options, command)
    // EOF on an unregistered launch (including a crash of core) means do not start.
    if (start) spec.args[3] = 'import sys; sys.stdin.read(1) == "g" or sys.exit(9); ' + spec.args[3]
    const { code, stdout } = await this.run(
      spec,
      start?.timeoutMs ?? (command.kind === 'stop' ? 345_000 : 30_000),
      start
    )
    let r: Record<string, unknown>
    try {
      const raw: unknown = JSON.parse(stdout)
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not an object')
      r = raw as Record<string, unknown>
    } catch {
      throw new AtomicCoreError('MODEL_LOAD_FAILED', 'Strata Control returned invalid JSON.')
    }
    if (
      code !== 0 &&
      !(command.kind === 'status' && r.ok === false && ['failed', 'stale'].includes(String(r.state))) &&
      !(
        command.kind === 'start' &&
        code === 8 &&
        r.error === 'startup_wait_expired' &&
        r.state === 'starting' &&
        r.ok === false
      )
    )
      throw new AtomicCoreError(
        'MODEL_LOAD_FAILED',
        'Strata Control command failed.',
        typeof r.error === 'string' ? r.error.slice(0, 4096) : undefined
      )
    return r
  }
}
