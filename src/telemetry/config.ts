import { parseDsn } from './dsn.js'
import type { ParsedDsn } from './dsn.js'

/**
 * The core's own Sentry project (`atomic-chat/atomic-chat-core`). A DSN is a public ingest key —
 * every shipped binary carries it — so it lives in the source: the core reports by itself however it
 * is run, as the app's daemon, as the CLI, or as a library inside another program.
 */
export const CORE_SENTRY_DSN =
  'https://8a1c01c8fc1288ec3e008c639cb00488@o4511535281012736.ingest.us.sentry.io/4512125097476096'

// Replaced by `bun build --define` in the release build (scripts/build-binaries.mjs). Everywhere else
// — tsc output, vitest, local binaries — they are not defined and `typeof` answers 'undefined'
// without a ReferenceError.
declare const __ATOMIC_CORE_SENTRY_DSN__: string | undefined
declare const __ATOMIC_CORE_SENTRY_ENVIRONMENT__: string | undefined
declare const __ATOMIC_CORE_GIT_SHA__: string | undefined

export interface BakedTelemetry {
  dsn?: string
  environment?: string
  gitSha?: string
}

/** What the release build baked into this binary. Empty in development and in tests. */
export const BAKED_TELEMETRY: BakedTelemetry = {
  ...(typeof __ATOMIC_CORE_SENTRY_DSN__ === 'string' ? { dsn: __ATOMIC_CORE_SENTRY_DSN__ } : {}),
  ...(typeof __ATOMIC_CORE_SENTRY_ENVIRONMENT__ === 'string'
    ? { environment: __ATOMIC_CORE_SENTRY_ENVIRONMENT__ }
    : {}),
  ...(typeof __ATOMIC_CORE_GIT_SHA__ === 'string' ? { gitSha: __ATOMIC_CORE_GIT_SHA__ } : {}),
}

export interface TelemetryConfig {
  dsn: ParsedDsn
  /** `production` for a release binary, `source` for anything built from source (a library user's). */
  environment: string
  /** `atomic-chat-core@<version>`: one release per published core, like the app's git-SHA release. */
  release: string
  /** The commit the binary was built from, when the build knew it. */
  dist?: string
}

/** A test runner: the built-in project must never hear from one. */
export function isTestRun(env: NodeJS.ProcessEnv): boolean {
  return env['VITEST'] !== undefined || env['NODE_ENV'] === 'test'
}

/**
 * Where error reports go, or null when they go nowhere. An explicit DSN (environment, then the
 * build) wins; otherwise the core's own project, except under a test runner. Release builds say
 * `production`, everything else `source`, so a library user's or a developer's build never mixes
 * with shipped binaries. The `development` environment turns reporting off, as it does in the app.
 */
export function resolveTelemetryConfig(input: {
  baked: BakedTelemetry
  env: NodeJS.ProcessEnv
  version: string
  /** Set when the process itself runs under a test runner, whatever `env` was injected. */
  testRun?: boolean
}): TelemetryConfig | null {
  const { baked, env } = input
  const explicit = env['ATOMIC_CORE_SENTRY_DSN']?.trim() || baked.dsn
  const testRun = input.testRun === true || isTestRun(env)
  const dsn = parseDsn(explicit || (testRun ? undefined : CORE_SENTRY_DSN))
  if (!dsn) return null
  const environment = env['ATOMIC_CORE_SENTRY_ENVIRONMENT']?.trim() || baked.environment || 'source'
  if (environment === 'development') return null
  const dist = baked.gitSha?.trim().slice(0, 12)
  return {
    dsn,
    environment,
    release: `atomic-chat-core@${input.version}`,
    ...(dist ? { dist } : {}),
  }
}
