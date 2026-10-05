/**
 * The Docker executor's two host-side seams, pointed into Atomic Chat's WSL distribution (change
 * `add-tensorrt-llm-windows`, task 2.6, design D3/D5): every docker argv `argv.ts` builds runs as the
 * guest's root through `wsl.exe --exec` — the guest's own `/usr/bin/docker` on its system socket, no
 * shell, no `docker` group — and every mount source is `realpath`-ed in the guest's filesystem, where
 * Docker will actually bind it, rather than on Windows, where the path does not exist.
 */
import type { WslDistributionTransport } from '../wsl/index.js'
import type { DockerExec, Realpath } from './types.js'

/** The docker CLI the guest recipe installs. */
export const GUEST_DOCKER_BINARY = '/usr/bin/docker'
const GUEST_ROOT = 'root'

export function guestDockerExec(transport: WslDistributionTransport): DockerExec {
  return (args, call) =>
    transport.exec([GUEST_DOCKER_BINARY, ...args], {
      user: GUEST_ROOT,
      ...(call?.timeoutMs === undefined ? {} : { timeoutMs: call.timeoutMs }),
    })
}

export function guestRealpath(transport: WslDistributionTransport): Realpath {
  return async (path) => {
    const resolved = await transport.exec(['realpath', '-e', '--', path], { user: GUEST_ROOT })
    if (resolved.code !== 0) throw new Error(resolved.stderr.trim() || `realpath -e ${path} failed`)
    return resolved.stdout.trim()
  }
}
