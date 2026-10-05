/**
 * Linux host-probe fixtures (`test/fixtures/linux-probe/`): realistic `os-release`, `nvidia-smi`,
 * `docker info`, `dpkg-query`/`rpm -q` and `nvidia-ctk cdi list` output, so the scenario tests in
 * `linux-plan.test.ts` drive `probeLinux` on real command shapes rather than hand-built facts.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export function readLinuxProbeFixture(relPath: string): string {
  return readFileSync(fileURLToPath(new URL(`../fixtures/linux-probe/${relPath}`, import.meta.url)), 'utf8')
}

/**
 * `docker -H unix:///var/run/docker.sock info --format '{{json .}}'` from a docker CLI ≥28.3 that could
 * not reach the daemon: exit 1, but still the fully-templated JSON document on stdout with the real
 * error in `ServerErrors` (28.3 changed the exit code, not the template output). The error also goes
 * to stderr. Structurally a `CommandOutput`.
 */
export const UNREACHABLE_28_3 = {
  code: 1,
  stdout: readLinuxProbeFixture('docker-info/unreachable-28-3-exit1.json'),
  stderr:
    'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock\n',
}

/** The same ≥28.3 shape when nothing listens on the socket at all (daemon stopped or not installed). */
export const DAEMON_DOWN_28_3 = {
  code: 1,
  stdout: readLinuxProbeFixture('docker-info/daemon-down-28-3-exit1.json'),
  stderr:
    'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n',
}
