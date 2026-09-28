/**
 * The child environment for a docker CLI call. `--host` (`argv.ts`) already forces the system
 * socket, but Docker context variables would still be consulted for anything `--host` doesn't cover
 * (TLS material, `DOCKER_CONFIG`'s credential store), so this strips them from the environment too —
 * between the two, no user Docker context is ever consulted (spec `tensorrt-llm-runtime`).
 */

/** Removed from every docker child process's environment. */
export const STRIPPED_DOCKER_ENV_VARS = ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG'] as const

/** A copy of `base` (default `process.env`) with the Docker context variables removed. `base` is never mutated. */
export function dockerChildEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  for (const key of STRIPPED_DOCKER_ENV_VARS) delete env[key]
  return env
}
