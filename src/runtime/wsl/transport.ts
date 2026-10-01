/**
 * Running things inside WSL from Windows (change `add-tensorrt-llm-windows`, task 2.2, design D1):
 * the one place `wsl.exe` is spawned. Everything the core does in Atomic Chat's own distribution —
 * probing the guest, running the install recipe, every docker call, the Engine API pull — goes
 * through `exec`; `wsl.exe`'s own commands (`--list`, `--import`, `--unregister`, …) through
 * `command`; keeping the distribution running through `hold`.
 *
 * Four things are deliberate.
 *
 * There is no shell, on either side. The command and every argument reach `spawn` as array elements,
 * and `wsl.exe --exec` hands them to the guest's `execvp` as they are — never to `/bin/sh` — so
 * nothing in a model path, a container name or a descriptor field is ever interpreted.
 *
 * Text is decoded, not assumed. `wsl.exe`'s own messages are UTF-16LE (`WSL_UTF8=1`, set on every
 * call, asks for UTF-8, which an older WSL ignores), while a guest command's output is its own bytes,
 * UTF-8; `decodeWslBytes` tells them apart.
 *
 * A command that could not answer — no `wsl.exe`, a spawn failure, past its deadline, aborted — is
 * `code: null`, never a rejection: the same contract as `hostExec` and the docker executor, so a
 * caller always gets one shape and reads "unknown" rather than "absent".
 *
 * The executable is injected. Production resolves the system `wsl.exe` from `%SystemRoot%`, never
 * `PATH`; tests pass `process.execPath` with a fake script as `executableArgs`, which runs the same on
 * a Windows CI runner as anywhere else (design D16).
 */

import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { HeadAndTail } from '../shared/index.js'

/** What one `wsl.exe` call answered. `code: null`: it never got as far as an exit code. */
export interface WslCommandOutput {
  code: number | null
  stdout: string
  stderr: string
}

export interface WslCallOptions {
  /** Overrides the default deadline for this call only. */
  timeoutMs?: number
  /** Stops the call: it answers `code: null` and its process is killed. */
  signal?: AbortSignal
  /** Written to the command's stdin, which is then closed. Without it stdin is not connected. */
  input?: string | Buffer
  /** Each piece of stdout as it arrives, decoded as UTF-8 (a guest command's own bytes). */
  onStdout?: (text: string) => void
}

export interface WslExecOptions extends WslCallOptions {
  /** `-u <user>`: the guest account to run as. The guest's default user when omitted. */
  user?: string
}

/** How a hold ended: `released` when the core let go itself, otherwise the process or the VM stopped. */
export interface WslHoldEnd {
  code: number | null
  signal: string | null
  released: boolean
}

/** An attached `wsl.exe -d <name> --exec sleep infinity`: the distribution stays up while it lives. */
export interface WslHold {
  /** Resolves once, when the holding process is gone — whoever ended it. */
  readonly exited: Promise<WslHoldEnd>
  /** Stop holding. Idempotent; `exited` then resolves with `released: true`. */
  release(): void
}

/** One distribution, as the core reaches it. */
export interface WslDistributionTransport {
  readonly name: string
  /** `wsl.exe -d <name> [-u <user>] --exec ...argv`. */
  exec(argv: string[], options?: WslExecOptions): Promise<WslCommandOutput>
  hold(): WslHold
}

export interface Wsl {
  /** `wsl.exe ...args`: its own commands, output decoded from UTF-16 when it comes that way. */
  command(args: string[], options?: WslCallOptions): Promise<WslCommandOutput>
  distribution(name: string): WslDistributionTransport
}

export interface WslOptions {
  /** The `wsl.exe` to run; `defaultWslExecutable(process.env)` when omitted. */
  executable?: string
  /** Arguments placed before every call's own (a test's fake script and its state folder). */
  executableArgs?: string[]
  /** The environment the process starts with; `process.env` when omitted. */
  env?: NodeJS.ProcessEnv
  /** Ask `wsl.exe` for UTF-8 (`WSL_UTF8=1`). On by default; a test turns it off to exercise UTF-16. */
  utf8?: boolean
  /** Default deadline per call. */
  timeoutMs?: number
  /** Per stream; past it the start and the end are kept (`HeadAndTail`). */
  maxOutputBytes?: number
  /** Tests only: stands in for `child_process.spawn`. */
  spawnProcess?: typeof spawn
}

const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const NUL = 0x00
const BOM = '\ufeff'

/** The system `wsl.exe`, from `%SystemRoot%` — never whatever `PATH` finds first. */
export function defaultWslExecutable(env: Record<string, string | undefined>): string {
  const root = env['SystemRoot'] ?? env['SYSTEMROOT'] ?? 'C:\\Windows'
  return `${root.replace(/[\\/]+$/, '')}\\System32\\wsl.exe`
}

/**
 * `wsl.exe`'s own text is UTF-16LE; a guest command's is UTF-8. UTF-16 is recognised by its BOM or by
 * NUL bytes — every ASCII character, `\r\n` included, carries one, and a guest's text output has
 * none — so a localized message (Cyrillic, CJK) decodes as well as an English one.
 */
export function decodeWslBytes(bytes: Buffer): string {
  if (bytes.length === 0) return ''
  const bom = bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe
  const text = bom || bytes.includes(NUL) ? bytes.toString('utf16le') : bytes.toString('utf8')
  return text.startsWith(BOM) ? text.slice(1) : text
}

export function createWsl(options: WslOptions = {}): Wsl {
  const executable = options.executable ?? defaultWslExecutable(process.env)
  const prefix = options.executableArgs ?? []
  const limit = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  const doSpawn = options.spawnProcess ?? spawn
  const env: NodeJS.ProcessEnv = {
    ...(options.env ?? process.env),
    ...(options.utf8 === false ? {} : { WSL_UTF8: '1' }),
  }

  const run = (args: string[], call: WslCallOptions = {}): Promise<WslCommandOutput> =>
    new Promise((resolve) => {
      const timeoutMs = call.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS
      if (call.signal?.aborted === true) {
        resolve({ code: null, stdout: '', stderr: 'aborted before it started' })
        return
      }
      let settled = false
      let child: ReturnType<typeof spawn> | undefined
      const stdout = new HeadAndTail(limit)
      const stderr = new HeadAndTail(limit)
      const streaming = call.onStdout === undefined ? null : new StringDecoder('utf8')

      const finish = (output: WslCommandOutput): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        call.signal?.removeEventListener('abort', onAbort)
        resolve(output)
      }
      const stop = (why: string): void => {
        child?.kill('SIGKILL')
        finish({ code: null, stdout: '', stderr: why })
      }
      const onAbort = (): void => stop('aborted')

      // Armed before the spawn, so a spawn that throws on the spot still has a real timer to clear.
      const timer = setTimeout(() => stop(`wsl.exe did not answer within ${timeoutMs} ms`), timeoutMs)
      timer.unref()
      call.signal?.addEventListener('abort', onAbort, { once: true })

      try {
        child = doSpawn(executable, [...prefix, ...args], {
          shell: false,
          windowsHide: true,
          stdio: [call.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
          env,
        })
      } catch (error) {
        finish({ code: null, stdout: '', stderr: (error as Error).message })
        return
      }

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout.push(chunk)
        if (streaming !== null) call.onStdout?.(streaming.write(chunk))
      })
      child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk))
      if (call.input !== undefined) {
        // A command that exits without reading its stdin closes the pipe under us; that is its answer.
        child.stdin?.on('error', () => undefined)
        child.stdin?.end(call.input)
      }
      // A missing executable arrives here as ENOENT, not as an exit code.
      child.on('error', (error) => finish({ code: null, stdout: '', stderr: error.message }))
      child.on('close', (code) => {
        if (streaming !== null) {
          const rest = streaming.end()
          if (rest !== '') call.onStdout?.(rest)
        }
        finish({ code, stdout: decodeWslBytes(stdout.bytes()), stderr: decodeWslBytes(stderr.bytes()) })
      })
    })

  const distribution = (name: string): WslDistributionTransport => ({
    name,
    exec: (argv, call = {}) =>
      run(['-d', name, ...(call.user === undefined ? [] : ['-u', call.user]), '--exec', ...argv], call),
    hold: () => {
      let released = false
      let child: ReturnType<typeof spawn> | undefined
      const exited = new Promise<WslHoldEnd>((resolve) => {
        let settled = false
        const end = (code: number | null, signal: string | null): void => {
          if (settled) return
          settled = true
          resolve({ code, signal, released })
        }
        try {
          child = doSpawn(executable, [...prefix, '-d', name, '--exec', 'sleep', 'infinity'], {
            shell: false,
            windowsHide: true,
            stdio: 'ignore',
            env,
          })
        } catch {
          end(null, null)
          return
        }
        child.on('error', () => end(null, null))
        child.on('exit', (code, signal) => end(code, signal))
      })
      return {
        exited,
        release: () => {
          if (released) return
          released = true
          child?.kill('SIGKILL')
        },
      }
    },
  })

  return { command: run, distribution }
}
