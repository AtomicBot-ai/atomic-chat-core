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
