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
 */
import { mkdir } from 'node:fs/promises'

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

/** Creates `dir` (and any missing parents) if it does not already exist. Idempotent. */
export async function ensureDockerConfigDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}
