/**
 * Finding — or starting — the core that owns a data folder (PLAN.md §3.6).
 *
 * Every command that needs a running core goes through here: read the lock, attach to a live owner,
 * and only when there is none, launch `daemon` as an independent process and wait for it to publish
 * its control port. The launched core does *not* die with us: that is the whole point of the owner
 * model, and it is why `serve` can be Ctrl+C'd without unloading the model.
 */

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { AtomicCoreError } from '../contracts/index.js'
import { CoreClient } from '../client/index.js'
import type { DataLayout } from '../config/index.js'
import { inspectLock, readControlToken, waitForPublishedOwner } from '../lock/index.js'
import type { LockRecord } from '../lock/index.js'
import { CORE_VERSION } from '../version.js'

export const DAEMON_START_TIMEOUT_MS = 20_000

export interface AttachedOwner {
  client: CoreClient
  record: LockRecord
  /** True when this process started the core we are now talking to. */
  launched: boolean
}

export interface AttachOptions {
  layout: DataLayout
  clientName: string
  /** Start a core when none is running. */
  launch?: boolean
  /** Argv[0] and any leading arguments needed to re-run this program (compiled binary vs source). */
  selfCommand?: string[]
  timeoutMs?: number
  log?: (message: string) => void
}

/**
 * How to re-invoke ourselves. Always through `process.execPath`: inside a compiled Bun binary
 * `argv[0]` is the literal string `bun`, which is not a program on the user's machine — spawning it
 * gave `Script not found "daemon"`. Running from source needs the script path as well.
 */
export function selfCommand(argv = process.argv, execPath = process.execPath): string[] {
  const script = argv[1]
  return script && /\.(c|m)?[jt]s$/.test(script) ? [execPath, script] : [execPath]
}

export async function attachToOwner(options: AttachOptions): Promise<AttachedOwner> {
  const state = await inspectLock(options.layout)
  if (state.kind === 'owned' && state.record.state === 'ready') {
    if (state.record.owner_scope !== 'cli' || state.record.version !== CORE_VERSION) {
      if (state.record.owner_scope === 'app')
        throw new AtomicCoreError('CORE_PROTOCOL_MISMATCH', 'The desktop application owns this folder.')
      if (!options.launch)
        throw new AtomicCoreError(
          'CORE_PROTOCOL_MISMATCH',
          'The running CLI core needs an upgrade; run a command that starts it.'
        )
      await replaceIdleDaemon(options, state.record)
      return attachToOwner(options)
    }
    return { client: await connect(options, state.record), record: state.record, launched: false }
  }
  if (!options.launch) {
    throw new AtomicCoreError(
      'CORE_NOT_RUNNING',
      'No Atomic Chat core is running for this data folder.',
      options.layout.root
    )
  }
  if (state.kind === 'owned') {
    const record = await waitForPublishedOwner(options.layout, {
      timeoutMs: options.timeoutMs ?? DAEMON_START_TIMEOUT_MS,
    })
    if (record.owner_scope !== 'cli' || record.version !== CORE_VERSION) return attachToOwner(options)
    return { client: await connect(options, record), record, launched: false }
  }
  const owner = await launchDaemon(options)
  return { client: await connect(options, owner.record), ...owner }
}

/** A CLI command owns a renewable registration only while it is doing work. */
export async function withAttachedOwner<T>(
  options: AttachOptions & { heartbeatIntervalMs?: number },
  work: (owner: AttachedOwner, clientId: string) => Promise<T>
): Promise<T> {
  const owner = await attachToOwner(options)
  const registration = await owner.client.register(process.pid)
  const clientId = registration.client.id
  let heartbeat: Promise<unknown> | undefined
  const timer = setInterval(() => {
    if (heartbeat) return
    heartbeat = owner.client
      .heartbeat(clientId)
      .catch((error: unknown) => options.log?.(`client heartbeat failed: ${String(error)}`))
      .finally(() => {
        heartbeat = undefined
      })
  }, options.heartbeatIntervalMs ?? registration.heartbeat_interval_ms)
  timer.unref?.()
  try {
    return await work(owner, clientId)
  } finally {
    clearInterval(timer)
    await heartbeat
    try {
      await owner.client.unregister(clientId)
    } catch {
      // A shutdown command or a crashed daemon cannot acknowledge unregister.
      // The registration also has a bounded TTL.
    }
  }
}

async function replaceIdleDaemon(options: AttachOptions, record: LockRecord): Promise<void> {
  const token = await readControlToken(options.layout)
  const client = new CoreClient({
    baseUrl: `http://${record.control_host}:${record.control_port}`,
    token,
    name: options.clientName,
  })
  const snapshot = await client.snapshot()
  if (snapshot.instance_id !== record.instance_id)
    throw new AtomicCoreError(
      'CORE_PROTOCOL_MISMATCH',
      'The CLI core changed during upgrade; retry the command.'
    )
  if (snapshot.clients.length)
    throw new AtomicCoreError(
      'CORE_ALREADY_RUNNING',
      'The old CLI core still has active clients. End their commands before updating.',
      snapshot.clients.map((c) => c.name).join(', ')
    )
  await client.shutdown()
  const deadline = Date.now() + (options.timeoutMs ?? DAEMON_START_TIMEOUT_MS)
  while (Date.now() < deadline) {
    const state = await inspectLock(options.layout)
    if (
      state.kind === 'free' ||
      state.kind === 'stale' ||
      (state.kind === 'owned' && state.record.instance_id !== record.instance_id)
    )
      return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new AtomicCoreError('CORE_ALREADY_RUNNING', 'The old CLI core did not release its lock.')
}

async function connect(options: AttachOptions, record: LockRecord): Promise<CoreClient> {
  const token = await readControlToken(options.layout)
  const client = new CoreClient({
    baseUrl: `http://${record.control_host}:${record.control_port}`,
    token,
    name: options.clientName,
  })
  await client.handshake('cli')
  return client
}

/**
 * Start the daemon detached, with its stdio closed after the handshake. The ready line is read from
 * the lock rather than the pipe, so a core that was started by someone else in the same moment is
 * just as good as the one we spawned.
 */
async function launchDaemon(options: AttachOptions): Promise<{ record: LockRecord; launched: boolean }> {
  const command = options.selfCommand ?? selfCommand()
  const [exe, ...prefix] = command
  const args = [...prefix, 'daemon', '--data-folder', options.layout.root, '--control-port', '0']
  options.log?.(`starting a core: ${[exe, ...args].join(' ')}`)
  const child = spawn(exe as string, args, {
    detached: true,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-4000)
  })
  child.stdout?.resume()
  const failed = new Promise<never>((_resolve, reject) => {
    child.once('error', (e) =>
      reject(new AtomicCoreError('CORE_START_FAILED', 'Could not start the Atomic Chat core.', e.message))
    )
    child.once('exit', (code, signal) =>
      reject(
        new AtomicCoreError(
          'CORE_START_FAILED',
          'The Atomic Chat core exited before it was ready.',
          `exit ${code ?? signal ?? '?'}${stderr ? `\n${stderr.trim()}` : ''}`
        )
      )
    )
  })
  try {
    const record = await Promise.race([
      waitForPublishedOwner(options.layout, { timeoutMs: options.timeoutMs ?? DAEMON_START_TIMEOUT_MS }),
      failed,
    ])
    // Detach: the core outlives this process, and we stop holding its pipes open.
    detachChild(child)
    return { record, launched: record.pid === child.pid }
  } catch (e) {
    child.removeAllListeners()
    // Two `serve` commands may both observe a free folder. One daemon wins the atomic lock and the
    // other exits; that loser is not a startup failure for its caller when the winner is already
    // publishing the same folder. Wait for that owner instead of rejecting one of the commands.
    const state = await inspectLock(options.layout)
    if (state.kind === 'owned') {
      try {
        const record = await waitForPublishedOwner(options.layout, {
          timeoutMs: options.timeoutMs ?? DAEMON_START_TIMEOUT_MS,
        })
        return { record, launched: record.pid === child.pid }
      } finally {
        detachChild(child)
      }
    }
    if (child.exitCode === null && child.signalCode === null) child.kill()
    detachChild(child)
    throw e
  }
}

function detachChild(child: ChildProcess): void {
  child.stdout?.destroy()
  child.stderr?.destroy()
  child.unref()
  child.removeAllListeners()
}
