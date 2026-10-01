/**
 * WSL's localhost forwarding, checked rather than assumed (change `add-tensorrt-llm-windows`, task
 * 2.7, design D7; spec "Проброс localhost проверяется, а не предполагается"). A model container
 * publishes its port on the guest's `127.0.0.1`, and Windows reaches it on its own `127.0.0.1` only
 * through WSL's forwarding — on by default in NAT mode, off with `localhostForwarding=false` in the
 * user's `.wslconfig`, and unreliable for Docker's ports in some `mirrored` setups. Core never edits
 * `.wslconfig` (it is global to every distribution the user has); it explains what to change.
 *
 * `checkLocalhostForwarding` is the install's check (`verifying`): a short-lived listener in the guest
 * on a random high port, confirmed from inside first, then from Windows. Only "inside yes, outside no"
 * is a forwarding failure; a listener that never came up is a failure of its own.
 */
import { AtomicCoreError } from '../../contracts/index.js'
import type { WslDistributionTransport } from '../wsl/index.js'
import type { WslConfigFacts } from './windows-probe.js'

const SHUTDOWN = 'Then run wsl --shutdown in a terminal and check again.'

/** `MANAGED_PREREQUISITE_BLOCKED` / `wsl-localhost-forwarding`, with what to change in `.wslconfig`. */
export function localhostForwardingError(config: WslConfigFacts): AtomicCoreError {
  const lead =
    'Windows cannot reach the TensorRT-LLM engine: it answers inside the Atomic Chat WSL distribution, but WSL does not forward its port to this computer’s 127.0.0.1.'
  const fix =
    config.localhost_forwarding === false
      ? `Your %UserProfile%\\.wslconfig turns this off: in its [wsl2] section, set localhostForwarding=true (or remove that line). ${SHUTDOWN}`
      : config.networking_mode === 'mirrored'
        ? `WSL runs in mirrored networking mode (networkingMode=mirrored in %UserProfile%\\.wslconfig), where forwarding of ports that Docker publishes can fail. Try networkingMode=nat in its [wsl2] section. ${SHUTDOWN}`
        : `Check %UserProfile%\\.wslconfig: in its [wsl2] section, localhostForwarding must not be false. ${SHUTDOWN}`
  return new AtomicCoreError('MANAGED_PREREQUISITE_BLOCKED', `${lead} ${fix}`, 'wsl-localhost-forwarding')
}

export interface ForwardingCheckDeps {
  transport: WslDistributionTransport
  fetch: typeof fetch
  sleep: (ms: number, signal: AbortSignal) => Promise<void>
  wslconfig: WslConfigFacts
  /** The guest port to listen on; a random high one by default. */
  port?: () => number
  signal: AbortSignal
}

const ATTEMPTS = 20
const INTERVAL_MS = 500
const LISTENER_SECONDS = 120

const randomPort = (): number => 20_000 + Math.floor(Math.random() * 40_000)

export async function checkLocalhostForwarding(deps: ForwardingCheckDeps): Promise<void> {
  const port = (deps.port ?? randomPort)()
  const stop = new AbortController()
  const abort = (): void => stop.abort()
  deps.signal.addEventListener('abort', abort, { once: true })
  // `timeout` bounds it even if this core dies before stopping it; python3 is part of the Ubuntu rootfs.
  const listener = deps.transport.exec(
    [
      'timeout',
      String(LISTENER_SECONDS),
      'python3',
      '-m',
      'http.server',
      '--bind',
      '127.0.0.1',
      String(port),
    ],
    { user: 'root', signal: stop.signal, timeoutMs: (LISTENER_SECONDS + 10) * 1000 }
  )
  try {
    let inside = false
    for (let attempt = 0; attempt < ATTEMPTS && !inside; attempt += 1) {
      const answer = await deps.transport.exec(
        [
          'curl',
          '--silent',
          '--output',
          '/dev/null',
          '--write-out',
          '%{http_code}',
          `http://127.0.0.1:${port}/`,
        ],
        { user: 'root', signal: deps.signal }
      )
      inside = answer.code === 0 && answer.stdout.trim() === '200'
      if (!inside) await deps.sleep(INTERVAL_MS, deps.signal)
    }
    if (!inside) {
      throw new AtomicCoreError(
        'IO_ERROR',
        'A test listener could not be started in the Atomic Chat distribution to check WSL’s localhost forwarding.',
        `port ${port}`
      )
    }
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      const reached = await deps
        .fetch(`http://127.0.0.1:${port}/`, { signal: deps.signal })
        .then(async (response) => {
          await response.body?.cancel().catch(() => undefined)
          return response.ok
        })
        .catch(() => false)
      if (reached) return
      await deps.sleep(INTERVAL_MS, deps.signal)
    }
    throw localhostForwardingError(deps.wslconfig)
  } finally {
    deps.signal.removeEventListener('abort', abort)
    stop.abort()
    await listener.catch(() => undefined)
  }
}
