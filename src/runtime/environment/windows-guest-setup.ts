/**
 * Making Atomic Chat's own WSL distribution (change `add-tensorrt-llm-windows`, task 2.5, design D9):
 * importing the verified rootfs as the user who runs the app, leaving their default distribution as it
 * was, and preparing the guest — a non-root default user (uid 1000), `/etc/wsl.conf` with systemd and
 * without the Windows `PATH`, and the ownership marker — then restarting it so systemd is PID 1.
 *
 * Everything runs through the WSL transport, never elevated (design D2), and never touches another
 * distribution: `--import` and `--set-default` name only what the caller passes, and every command in a
 * guest names Atomic Chat's own. Each step checks before it acts, so a setup interrupted half-way
 * resumes by running the same steps again.
 */

import { AtomicCoreError } from '../../contracts/index.js'
import type { Wsl, WslDistributionTransport } from '../wsl/index.js'
import { GUEST_ROOT } from './guest-host.js'
import { parseWslDistributions } from './windows-probe.js'

/** The account the guest's files and the model container belong to (design D5). */
export const GUEST_USER_UID = 1000
/** Its name when the rootfs has no uid 1000 yet. */
export const GUEST_USER_NAME = 'atomic'
/** Where the import records that this distribution is Atomic Chat's. */
export const GUEST_OWNER_MARKER = '/etc/atomic-chat/owner'

const IMPORT_TIMEOUT_MS = 30 * 60_000
const GUEST_TIMEOUT_MS = 120_000
/** How long a restarted guest may take to bring systemd up. */
const SYSTEMD_WAIT_ATTEMPTS = 60
const SYSTEMD_WAIT_MS = 1_000

const failed = (message: string, details?: string): AtomicCoreError =>
  new AtomicCoreError('MANAGED_PREREQUISITE_BLOCKED', message, details)

const said = (output: { stdout: string; stderr: string }): string =>
  `${output.stdout.trim()}\n${output.stderr.trim()}`.trim().slice(-2000)

/**
 * `wsl --import <name> <dir> <file> --version 2`; when that refuses the `.wsl` file, the same file
 * through `wsl --install --from-file … --name … --location … --no-launch` (design D9: whether `--import`
 * takes the `.wsl` format directly is a live-acceptance question). Confirmed by `--list` afterwards.
 */
export async function importDistribution(
  wsl: Wsl,
  target: { name: string; path: string; rootfs: string },
  signal: AbortSignal
): Promise<void> {
  const imported = await wsl.command(
    ['--import', target.name, target.path, target.rootfs, '--version', '2'],
    {
      timeoutMs: IMPORT_TIMEOUT_MS,
      signal,
    }
  )
  if (imported.code !== 0) {
    const installed = await wsl.command(
      [
        '--install',
        '--from-file',
        target.rootfs,
        '--name',
        target.name,
        '--location',
        target.path,
        '--no-launch',
      ],
      { timeoutMs: IMPORT_TIMEOUT_MS, signal }
    )
    if (installed.code !== 0) {
      throw failed(
        `WSL could not import the Atomic Chat distribution "${target.name}".`,
        `wsl --import: ${said(imported)}\nwsl --install --from-file: ${said(installed)}`
      )
    }
  }
  const listed = parseWslDistributions(await wsl.command(['--list', '--verbose'], { signal }))
  if (!listed.some((entry) => entry.name === target.name)) {
    throw failed(`WSL reported the import of "${target.name}" as done, but does not list it.`)
  }
}

/**
 * Put the user's default distribution back if the import took it. With no default before, there is
 * nothing to restore: the user had none of their own to keep.
 */
export async function restoreDefaultDistribution(
  wsl: Wsl,
  previous: string | null,
  signal: AbortSignal
): Promise<void> {
  if (previous === null) return
  const listed = parseWslDistributions(await wsl.command(['--list', '--verbose'], { signal }))
  if (listed.find((entry) => entry.is_default)?.name === previous) return
  const restored = await wsl.command(['--set-default', previous], { signal })
  if (restored.code !== 0) {
    throw failed(`Your default WSL distribution "${previous}" could not be set back.`, said(restored))
  }
}

/** `/etc/wsl.conf` as Atomic Chat's guest needs it. */
export function guestWslConf(user: string): string {
  return [
    '[boot]',
    'systemd=true',
    '',
    '[user]',
    `default=${user}`,
    '',
    '[interop]',
    'appendWindowsPath=false',
    '',
  ].join('\n')
}

export interface GuestSetupDeps {
  wsl: Wsl
  sleep: (ms: number, signal: AbortSignal) => Promise<void>
}

/**
 * The guest's own setup, idempotent: the uid-1000 user (reused when the rootfs already has one), the
 * ownership marker (a different one already there means this is not our distribution), `/etc/wsl.conf`
 * — and, when that file changed, a restart of the distribution and a wait until systemd runs.
 */
export async function setupGuest(
  deps: GuestSetupDeps,
  transport: WslDistributionTransport,
  marker: string,
  signal: AbortSignal
): Promise<{ user: string; restarted: boolean }> {
  const run = (argv: string[], input?: string) =>
    transport.exec(argv, {
      user: GUEST_ROOT,
      timeoutMs: GUEST_TIMEOUT_MS,
      signal,
      ...(input === undefined ? {} : { input }),
    })
  const must = async (argv: string[], what: string, input?: string) => {
    const output = await run(argv, input)
    if (output.code !== 0)
      throw failed(`Preparing the Atomic Chat distribution failed: ${what}.`, said(output))
    return output
  }
  const readGuestFile = async (path: string): Promise<string | null> => {
    const exists = await run(['test', '-e', path])
    if (exists.code !== 0) return null
    return (await must(['cat', '--', path], `reading ${path}`)).stdout
  }
  const writeGuestFile = async (path: string, text: string): Promise<void> => {
    const directory = path.slice(0, path.lastIndexOf('/'))
    await must(['mkdir', '-p', directory], `creating ${directory}`)
    await must(['tee', `${path}.tmp`], `writing ${path}`, text)
    await must(['chmod', '0644', `${path}.tmp`], `setting the mode of ${path}`)
    await must(['mv', '-f', `${path}.tmp`, path], `writing ${path}`)
  }

  const existing = await run(['getent', 'passwd', String(GUEST_USER_UID)])
  let user: string
  if (existing.code === 0 && existing.stdout.includes(':')) {
    user = existing.stdout.split(':')[0] as string
  } else {
    await must(
      [
        'useradd',
        '--create-home',
        '--uid',
        String(GUEST_USER_UID),
        '--user-group',
        '--shell',
        '/bin/bash',
        GUEST_USER_NAME,
      ],
      `creating the user ${GUEST_USER_NAME}`
    )
    user = GUEST_USER_NAME
  }

  const owner = await readGuestFile(GUEST_OWNER_MARKER)
  if (owner !== null && owner.trim() !== marker) {
    throw new AtomicCoreError(
      'MANAGED_PREREQUISITE_BLOCKED',
      `The WSL distribution "${transport.name}" carries another installation's marker; Atomic Chat will not use it.`,
      'foreign-distribution'
    )
  }
  if (owner === null) await writeGuestFile(GUEST_OWNER_MARKER, `${marker}\n`)

  const wanted = guestWslConf(user)
  if ((await readGuestFile('/etc/wsl.conf')) === wanted) return { user, restarted: false }
  await writeGuestFile('/etc/wsl.conf', wanted)
  // wsl.conf applies at the next start of the distribution: stop it, and the next command boots it.
  const terminated = await deps.wsl.command(['--terminate', transport.name], { signal })
  if (terminated.code !== 0)
    throw failed(`The distribution "${transport.name}" could not be restarted.`, said(terminated))
  for (let attempt = 0; attempt < SYSTEMD_WAIT_ATTEMPTS; attempt += 1) {
    if ((await run(['test', '-e', '/run/systemd/system'])).code === 0) return { user, restarted: true }
    await deps.sleep(SYSTEMD_WAIT_MS, signal)
  }
  throw failed(`systemd did not start in the distribution "${transport.name}" after its restart.`)
}
