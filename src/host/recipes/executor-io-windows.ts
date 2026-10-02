/**
 * The real I/O behind `executeHostStep` on Windows (change `add-tensorrt-llm-windows`, task 2.4,
 * design D15), for a process UAC elevated. The Linux checks (`executor-io.ts`) trust a folder by its
 * uid and mode bits; Windows has neither, so the same promise is kept with its owner and its ACL.
 *
 * The app writes `<step_id>.request.json` into a folder under the user's `%LOCALAPPDATA%` whose ACL
 * grants access only to the user, `SYSTEM` and `Administrators`, then runs this executor elevated.
 * Before the request is read and again before the result is written, the folder — and the request
 * itself — must be:
 *
 * - a real directory (file), not a reparse point: a junction or a symlink could send the elevated
 *   write of `<step_id>.result.json` into a system folder;
 * - owned by an account, not by a broad group (`Everyone`, `Users`, `Authenticated Users`, …);
 * - writable by nobody but that owner, `SYSTEM`, `Administrators` and `CREATOR OWNER`: an `Allow`
 *   entry granting any write, delete or permission-changing right to anyone else refuses it.
 *
 * Owner and ACL are read by SID, never by name (names are localized): one PowerShell query per
 * path, the path passed in an environment variable rather than spliced into the script. Every file
 * the executor writes goes to a fresh temporary name created exclusively and is renamed into place.
 *
 * Commands: only `wsl.exe`, resolved to `%SystemRoot%\System32\wsl.exe`; anything else is refused —
 * the only recipe that runs on Windows is `windows.enable-wsl`.
 */

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { lstat, open, readFile, rename, rm } from 'node:fs/promises'
import { win32 } from 'node:path'
import { AtomicCoreError } from '../../contracts/index.js'
import { hostExec, parseRebootPending, REBOOT_PENDING_KEY } from '../../runtime/environment/index.js'
import type { HostCommandOutput, HostStepExecutorDeps } from './executor.js'

/** One access rule as `Get-Acl` reports it, by SID. */
export interface WindowsAclRule {
  sid: string
  allow: boolean
  rights: number
}

/** A path's owner, ACL and whether it is a reparse point. */
export interface WindowsAcl {
  reparse: boolean
  directory: boolean
  owner: string
  rules: WindowsAclRule[]
}

const SYSTEM = 'S-1-5-18'
const ADMINISTRATORS = 'S-1-5-32-544'
const CREATOR_OWNER = 'S-1-3-0'
/** Never an acceptable owner: a group anyone on the machine belongs to. */
const BROAD = new Set([
  'S-1-1-0', // Everyone
  'S-1-5-11', // Authenticated Users
  'S-1-5-32-545', // Users
  'S-1-5-32-546', // Guests
  'S-1-5-4', // Interactive
  'S-1-5-7', // Anonymous
])

/**
 * Any right that lets its holder change what is in the folder or who may: write or append data,
 * write attributes, delete a child or the object, change its permissions or owner, and the generic
 * write and all bits.
 */
const WRITE_RIGHTS = 0x2 | 0x4 | 0x10 | 0x40 | 0x100 | 0x10000 | 0x40000 | 0x80000 | 0x10000000 | 0x40000000

/** Why `acl` cannot be trusted for `what`, or null when it can. Pure. */
export function judgeWindowsAcl(acl: WindowsAcl, what: string, expect: 'directory' | 'file'): string | null {
  if (acl.reparse) return `${what} is a reparse point (a junction or a link is refused)`
  if (acl.directory !== (expect === 'directory')) return `${what} is not a ${expect}`
  if (BROAD.has(acl.owner)) return `${what} is owned by ${acl.owner}, a group anyone belongs to`
  const trusted = new Set([acl.owner, SYSTEM, ADMINISTRATORS, CREATOR_OWNER])
  const writers = acl.rules
    .filter((rule) => rule.allow && (rule.rights & WRITE_RIGHTS) !== 0 && !trusted.has(rule.sid))
    .map((rule) => rule.sid)
  return writers.length === 0 ? null : `${what} is writable by ${[...new Set(writers)].join(', ')}`
}

const ACL_QUERY = [
  '$p = $env:ATOMIC_HOST_STEP_PATH',
  '$i = Get-Item -LiteralPath $p -Force',
  '$a = Get-Acl -LiteralPath $p',
  '$t = [System.Security.Principal.SecurityIdentifier]',
  '[pscustomobject]@{',
  '  reparse = [bool]($i.Attributes -band [System.IO.FileAttributes]::ReparsePoint)',
  '  directory = [bool]$i.PSIsContainer',
  '  owner = $a.GetOwner($t).Value',
  '  rules = @($a.GetAccessRules($true, $true, $t) | ForEach-Object {',
  "    [pscustomobject]@{ sid = $_.IdentityReference.Value; allow = ($_.AccessControlType -eq 'Allow'); rights = [int64]$_.FileSystemRights } })",
  '} | ConvertTo-Json -Compress -Depth 4',
].join('\n')

/** `Get-Acl`'s answer, parsed; throws when PowerShell did not give one. */
export function parseWindowsAcl(output: HostCommandOutput): WindowsAcl {
  if (output.code !== 0) throw new Error(`Get-Acl failed (${String(output.code)}): ${output.stderr.trim()}`)
  const raw = JSON.parse(output.stdout) as Partial<WindowsAcl> & { rules?: unknown }
  const rules = (
    Array.isArray(raw.rules) ? raw.rules : raw.rules === undefined ? [] : [raw.rules]
  ) as WindowsAclRule[]
  if (
    typeof raw.owner !== 'string' ||
    typeof raw.reparse !== 'boolean' ||
    typeof raw.directory !== 'boolean'
  ) {
    throw new Error('Get-Acl answered without an owner')
  }
  return {
    reparse: raw.reparse,
    directory: raw.directory,
    owner: raw.owner,
    rules: rules.map((rule) => ({
      sid: String(rule.sid),
      allow: rule.allow === true,
      rights: Number(rule.rights),
    })),
  }
}

/** The calls this module makes, injectable so a test fakes owners and ACLs it cannot create. */
export interface WindowsHostStepIo {
  /** Runs one command, no shell; `env` is added to the inherited environment. */
  exec(
    command: string,
    args: string[],
    options?: { timeoutMs?: number; env?: Record<string, string>; console?: boolean }
  ): Promise<HostCommandOutput>
  /** Whether `path` is a symlink/junction, a file, a directory, and its size. */
  lstat(
    path: string
  ): Promise<{ isSymbolicLink(): boolean; isFile(): boolean; isDirectory(): boolean; size: number }>
  readFile(path: string): Promise<string>
  /** Creates `path` exclusively and writes `text`; never follows or replaces what is there. */
  createExclusive(path: string, text: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  remove(path: string): Promise<void>
}

/**
 * Runs `command` with this process's own console (stdio inherited, window hidden), no shell, and
 * resolves with the exit code only. The elevated executor is started by the app with `SW_HIDE`, so the
 * console it shares is invisible. Used for the inbox `wsl.exe --install`, which refuses to install
 * when its output is a pipe.
 */
const consoleExec = (command: string, args: string[], timeoutMs: number): Promise<HostCommandOutput> =>
  new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'inherit', windowsHide: true, shell: false })
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.once('error', (error) => {
      clearTimeout(timer)
      resolve({ code: null, stdout: '', stderr: error.message })
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout: '', stderr: '' })
    })
  })

const nodeIo = (): WindowsHostStepIo => {
  return {
    exec: (command, args, options) =>
      options?.console === true
        ? consoleExec(command, args, options.timeoutMs ?? 60_000)
        : hostExec({ timeoutMs: options?.timeoutMs ?? 60_000 })(command, args, options?.env),
    lstat: (path) => lstat(path),
    readFile: (path) => readFile(path, 'utf8'),
    createExclusive: async (path, text) => {
      const handle = await open(path, 'wx', 0o644)
      try {
        await handle.writeFile(text)
        await handle.sync()
      } finally {
        await handle.close()
      }
    },
    rename: (from, to) => rename(from, to),
    remove: (path) => rm(path, { force: true }),
  }
}

const REQUEST_SIZE_LIMIT = 64 * 1024
/** `wsl --install` downloads the WSL package from the Store: minutes, not hours. */
const INSTALL_TIMEOUT_MS = 30 * 60_000
const COMMAND_TIMEOUT_MS = 5 * 60_000

const refuse = (message: string): never => {
  throw new AtomicCoreError('MANAGED_HOST_STEP_INVALID', message)
}

/**
 * The executor's dependencies on a Windows machine. `env` gives `%SystemRoot%`, where the only
 * command it runs — `wsl.exe` — and PowerShell live.
 */
export function windowsHostStepDeps(
  env: NodeJS.ProcessEnv,
  io: WindowsHostStepIo = nodeIo()
): HostStepExecutorDeps {
  const system32 = `${(env['SystemRoot'] ?? env['SYSTEMROOT'] ?? 'C:\\Windows').replace(/[\\/]+$/, '')}\\System32`
  const powershell = `${system32}\\WindowsPowerShell\\v1.0\\powershell.exe`

  const trust = async (path: string, what: string, expect: 'directory' | 'file'): Promise<void> => {
    let acl: WindowsAcl
    try {
      acl = parseWindowsAcl(
        await io.exec(powershell, ['-NoProfile', '-NonInteractive', '-Command', ACL_QUERY], {
          env: { ATOMIC_HOST_STEP_PATH: path },
        })
      )
    } catch (error) {
      return refuse(`could not read the owner and permissions of ${what}: ${(error as Error).message}`)
    }
    const problem = judgeWindowsAcl(acl, what, expect)
    if (problem !== null) refuse(problem)
  }

  return {
    readRequest: async (path) => {
      const folder = win32.dirname(path)
      await trust(folder, folder, 'directory')
      const info = await io.lstat(path)
      if (info.isSymbolicLink() || !info.isFile()) refuse(`${path} is not a regular file`)
      if (info.size > REQUEST_SIZE_LIMIT) refuse(`${path} is too large to be a request`)
      await trust(path, path, 'file')
      return io.readFile(path)
    },
    writeResult: async (path, text) => {
      const folder = win32.dirname(path)
      await trust(folder, folder, 'directory')
      const temp = win32.join(folder, `.${win32.basename(path)}.${randomBytes(6).toString('hex')}.tmp`)
      try {
        await io.createExclusive(temp, text)
        await io.rename(temp, path)
      } catch (error) {
        // Only our own temporary file: it was created exclusively.
        await io.remove(temp)
        throw error
      }
    },
    readFile: async () => refuse('the Windows executor reads no system file'),
    writeFile: async () => refuse('the Windows executor writes no system file'),
    exec: async ([command, ...args], options) => {
      if (command !== 'wsl.exe')
        return refuse(`${String(command)} is not a command the Windows executor runs`)
      return io.exec(`${system32}\\wsl.exe`, args, {
        timeoutMs: options?.longRunning === true ? INSTALL_TIMEOUT_MS : COMMAND_TIMEOUT_MS,
        ...(options?.console === true ? { console: true } : {}),
      })
    },
    fetch: async () => refuse('the Windows executor downloads nothing'),
    rebootPending: async () =>
      parseRebootPending(await io.exec(`${system32}\\reg.exe`, ['query', REBOOT_PENDING_KEY])),
    now: () => Date.now(),
    invokingUid: null,
  }
}
