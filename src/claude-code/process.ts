import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import { AtomicCoreError } from '../contracts/index.js'
import { cleanEnvironment, MAX_EVENT_BYTES } from './policy.js'

export interface ClaudeProcessOptions {
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  home: string
  cwd: string
  /** Trusted host configuration, never supplied by a control request. */
  executable?: string | undefined
  prefixArgs?: string[] | undefined
}

export async function findExecutable(options: ClaudeProcessOptions): Promise<string | undefined> {
  const name = options.platform === 'win32' ? 'claude.exe' : 'claude'
  const paths = options.executable
    ? [options.executable]
    : [
        join(options.home, '.local', 'bin', name),
        join(options.home, '.npm-global', 'bin', name),
        ...(options.env['PATH'] ?? '')
          .split(options.platform === 'win32' ? ';' : delimiter)
          .filter(Boolean)
          .map((dir) => join(dir, name)),
        ...(options.platform === 'win32'
          ? []
          : [join('/opt/homebrew/bin', name), join('/usr/local/bin', name)]),
      ]
  for (const path of paths) {
    if (!isAbsolute(path)) continue
    try {
      await access(path, options.platform === 'win32' ? constants.F_OK : constants.X_OK)
      return path
    } catch {
      /* Try the next installed location. */
    }
  }
  return undefined
}

/** Bounded stdout, stdin prompts, no shell, and guaranteed child cleanup. */
export async function runProcess(
  options: ClaudeProcessOptions,
  args: string[],
  config: {
    signal?: AbortSignal | undefined
    timeoutMs: number
    allowedExitCodes?: number[]
    input?: string | undefined
    keepInputOpen?: boolean
    onLine?: ((line: string) => Promise<boolean | void> | boolean | void) | undefined
  }
): Promise<string> {
  config.signal?.throwIfAborted()
  const executable = await findExecutable(options)
  if (!executable)
    throw new AtomicCoreError(
      'BINARY_NOT_FOUND',
      'Install the official native Claude Code CLI, then check the connection again.'
    )
  const child = spawn(
    executable,
    [...(options.prefixArgs ?? []), '--safe-mode', '--setting-sources', '', ...args],
    {
      env: cleanEnvironment(options.env),
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    }
  )
  let processError: Error | undefined
  const exited = new Promise<number | null>((resolve) => {
    child.once('error', (error) => {
      processError = error
    })
    child.once('close', resolve)
  })
  let timedOut = false
  const kill = () => {
    child.kill('SIGKILL')
  }
  const timer = setTimeout(() => {
    timedOut = true
    kill()
  }, config.timeoutMs)
  config.signal?.addEventListener('abort', kill, { once: true })
  if (config.signal?.aborted) kill()
  // EPIPE is surfaced through the exit status, not an unhandled stream error.
  child.stdin.on('error', () => {})
  if (config.keepInputOpen) child.stdin.write(config.input ?? '')
  else child.stdin.end(config.input ?? '')
  child.stdout.setEncoding('utf8')
  let pending = ''
  let captured = ''
  let early = false
  try {
    for await (const chunk of child.stdout) {
      pending += String(chunk)
      if (Buffer.byteLength(pending) > MAX_EVENT_BYTES)
        throw new AtomicCoreError('PROCESS_ERROR', 'Claude Code output exceeded the size limit.')
      let end: number
      while ((end = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, end)
        pending = pending.slice(end + 1)
        if (config.onLine) {
          if (await config.onLine(line)) {
            early = true
            break
          }
        } else {
          captured += `${line}\n`
          if (Buffer.byteLength(captured) > MAX_EVENT_BYTES)
            throw new AtomicCoreError('PROCESS_ERROR', 'Claude Code output exceeded the size limit.')
        }
      }
      if (early) break
    }
    if (early) kill()
    const code = await exited
    config.signal?.throwIfAborted()
    if (timedOut) throw new AtomicCoreError('PROCESS_ERROR', 'Claude Code timed out.')
    if (processError)
      throw new AtomicCoreError('PROCESS_ERROR', `Could not launch Claude Code: ${processError.message}`)
    if (!early && !(config.allowedExitCodes ?? [0]).includes(code ?? -1))
      throw new AtomicCoreError(
        'PROCESS_ERROR',
        `Claude Code exited unsuccessfully (${code ?? 'signal'}). Check your login, plan limits, and CLI version.`
      )
    if (pending.trim() && !early) {
      if (config.onLine) await config.onLine(pending)
      else captured += pending
    }
    return captured
  } finally {
    clearTimeout(timer)
    config.signal?.removeEventListener('abort', kill)
    kill()
    await exited
  }
}
