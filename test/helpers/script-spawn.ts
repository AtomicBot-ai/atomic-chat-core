/**
 * A runtime `spawn` seam that runs `node -e <script>` in place of the backend, through the production
 * readiness logic. For output the fake servers never print on their own, such as a line that comes
 * well after the ready line.
 */
import { spawnAndAwaitReady } from '../../src/runtime/index.js'
import type { ReadyOptions, SpawnSpec } from '../../src/runtime/index.js'

export function scriptSpawn(script: string) {
  return (spec: SpawnSpec, opts: ReadyOptions) =>
    spawnAndAwaitReady(
      {
        exe: process.execPath,
        args: ['-e', script],
        env: spec.env,
        ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}),
      },
      opts
    )
}
