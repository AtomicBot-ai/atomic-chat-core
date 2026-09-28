/**
 * The child environment for a docker CLI call.
 *
 * Review round 1, item 5 (RULING): the first version of this file only *deleted* `DOCKER_CONFIG`
 * from the child's environment, on the theory that an absent variable means "no config". It does
 * not: with `DOCKER_CONFIG` unset, the docker CLI falls back to `$HOME/.docker/config.json` — the
 * user's own config, which can carry a `credsStore` (a credential helper the CLI would invoke on the
 * user's behalf) and `proxies` (`HttpProxy`/`HttpsProxy`/`NoProxy` settings the CLI injects as env
 * vars into every container it creates). Deleting the variable does not isolate the call; it makes
 * the call adopt whatever the user's own Docker identity happens to be. The fix is to *set*
 * `DOCKER_CONFIG` to an empty directory this module owns (injectable — production wiring picks a
 * real path under core's data root; tests point it at a temp directory), so the CLI reads that empty
 * directory (no `config.json` inside → no creds, no injected proxies) instead of falling back.
 * `ensureDockerConfigDir` creates it if missing; `--host` (`argv.ts`) separately forces the system
 * socket, so between the two, no user Docker context is ever consulted.
 *
 * Review round 2, item 3 (controller ruling): an empty *directory* alone is not a guarantee of
 * emptiness — something else could later write a `config.json` into it (another tool, a stray copy,
 * a future bug elsewhere in this codebase), and the docker CLI would read whatever showed up.
 * `ensureDockerConfigDir` now also atomically writes `config.json` containing `{}` into the
 * directory on every call (write to a `.tmp` file, then `rename` over the real one — the same
 * write-then-rename convention as `src/settings/store.ts`'s `persist`), so the directory's content is
 * guaranteed, in code, not just by nothing having gotten there yet.
 */
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Removed outright: `--host` (`argv.ts`) already replaces what these two would otherwise select. */
export const STRIPPED_DOCKER_ENV_VARS = ['DOCKER_HOST', 'DOCKER_CONTEXT'] as const

export interface DockerChildEnvOptions {
  /** An empty, core-owned directory the docker CLI reads as `$DOCKER_CONFIG`. Not created by this function — call `ensureDockerConfigDir` first. */
  dockerConfigDir: string
  /** Defaults to `process.env`. Never mutated. */
  base?: NodeJS.ProcessEnv
}

/** A copy of `options.base` (default `process.env`) with `DOCKER_HOST`/`DOCKER_CONTEXT` removed and `DOCKER_CONFIG` pointed at `options.dockerConfigDir`. */
export function dockerChildEnv(options: DockerChildEnvOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...(options.base ?? process.env) }
  for (const key of STRIPPED_DOCKER_ENV_VARS) delete env[key]
  env['DOCKER_CONFIG'] = options.dockerConfigDir
  return env
}

/** The docker CLI's config file, forced empty (review round 2, item 3): no `credsStore`, no `proxies`. */
const EMPTY_DOCKER_CONFIG_JSON = '{}\n'

/**
 * Creates `dir` (and any missing parents) if it does not already exist, then atomically writes an
 * empty `config.json` into it (write to `config.json.tmp`, then `rename` over `config.json`) — every
 * call re-asserts emptiness, rather than trusting that nothing has written there since the last call.
 * Idempotent: safe to call before every docker invocation.
 */
export async function ensureDockerConfigDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  const configPath = join(dir, 'config.json')
  const tmpPath = `${configPath}.tmp`
  await writeFile(tmpPath, EMPTY_DOCKER_CONFIG_JSON, { encoding: 'utf8', mode: 0o600 })
  await rename(tmpPath, configPath)
}
