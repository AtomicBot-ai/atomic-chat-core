import { parseDsn } from './dsn.js'
import type { ParsedDsn } from './dsn.js'

// Replaced by `bun build --define` in the release build of the app's binary only
// (scripts/build-binaries.mjs). Everywhere else — tsc output, vitest, the CLI binary — they are not
// defined, `typeof` answers 'undefined' without a ReferenceError, and reporting stays off.
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
  environment: string
  /** `atomic-chat-core@<version>`: one release per published core, like the app's git-SHA release. */
  release: string
  /** The commit the binary was built from, when the build knew it. */
  dist?: string
}

/**
 * Where error reports go, or null when they go nowhere. Environment variables override the baked
 * values so a developer can point a local build at a real project; the `development` environment
 * turns reporting off entirely, as it does in the app (`src-tauri/src/core/telemetry/mod.rs`).
 */
export function resolveTelemetryConfig(input: {
  baked: BakedTelemetry
  env: NodeJS.ProcessEnv
  version: string
}): TelemetryConfig | null {
  const { baked, env } = input
  const dsn = parseDsn(env['ATOMIC_CORE_SENTRY_DSN']?.trim() || baked.dsn)
  if (!dsn) return null
  const environment = env['ATOMIC_CORE_SENTRY_ENVIRONMENT']?.trim() || baked.environment || 'production'
  if (environment === 'development') return null
  const dist = baked.gitSha?.trim().slice(0, 12)
  return {
    dsn,
    environment,
    release: `atomic-chat-core@${input.version}`,
    ...(dist ? { dist } : {}),
  }
}
