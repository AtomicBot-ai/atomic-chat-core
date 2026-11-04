/**
 * How a fake engine that `fake-model-docker.mjs` started ends on its own. `docker start` runs it
 * detached, so only a test's `afterEach` used to kill it: a run that died first (a killed vitest, a
 * timed-out shell) or a suite that never stops its containers (`*-check`, the Windows path) left
 * every engine it started listening for good. An engine now exits once the fake docker's state file
 * (`FAKE_DOCKER_STATE`, inherited from the `docker start` that spawned it) is gone — the test removed
 * its temporary folder — and in any case after `MAX_LIFETIME_MS`, far longer than any e2e test keeps
 * a container.
 */
import { existsSync } from 'node:fs'

const MAX_LIFETIME_MS = 5 * 60_000
const CHECK_EVERY_MS = 1_000

export function exitWithTheTest() {
  const state = process.env.FAKE_DOCKER_STATE
  if (state) {
    setInterval(() => {
      if (!existsSync(state)) process.exit(0)
    }, CHECK_EVERY_MS).unref()
  }
  setTimeout(() => process.exit(0), MAX_LIFETIME_MS).unref()
}
