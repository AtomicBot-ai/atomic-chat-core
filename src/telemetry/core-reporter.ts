/**
 * The reporter a core builds for itself, whoever embeds it: the app's daemon (`atomic-chat`), the CLI
 * (`cli`) or a program that imports the library (`library`, or the name it gives). The host may say
 * on or off; the environment and the user's stored choice are read here; without any of them the
 * core reports (see `resolveConsent`).
 */

import { cpus, release, totalmem } from 'node:os'
import { BAKED_TELEMETRY, isTestRun, resolveTelemetryConfig } from './config.js'
import type { BakedTelemetry } from './config.js'
import { envConsent, resolveConsent } from './consent.js'
import type { SystemContext } from './envelope.js'
import { ErrorReporter } from './reporter.js'
import { ensureInstallId, readTelemetryFile, writeTelemetryFile } from './store.js'

/** What `node:os` says about this machine, without anything that names it or its user. */
export function systemContext(): SystemContext {
  const cpu = cpus()[0]?.model?.trim()
  return {
    osRelease: release(),
    ...(cpu ? { cpuModel: cpu } : {}),
    memoryMb: Math.round(totalmem() / (1024 * 1024)),
  }
}

export interface CoreReporterInput {
  /** `atomic-chat`, `cli`, `library`, or the embedding program's own name. */
  host: string
  hostVersion?: string | undefined
  ownerScope?: 'app' | 'cli' | undefined
  /** The host's consent, when it gave one (`--telemetry on|off`, `AtomicCore.create({ telemetry })`). */
  enabled?: boolean | undefined
  dataFolder: string
  /** `<data>/atomic-core/telemetry.json` (`DataLayout.core.telemetry`). */
  telemetryFile: string
  homeDir: string
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  arch: string
  version: string
  warn: (message: string) => void
  baked?: BakedTelemetry | undefined
  fetch?: typeof fetch | undefined
  system?: SystemContext | undefined
  /** Overrides the check of the real process for a test runner (tests of this very function). */
  testRun?: boolean | undefined
}

export async function createCoreReporter(input: CoreReporterInput): Promise<ErrorReporter> {
  const config = resolveTelemetryConfig({
    baked: input.baked ?? BAKED_TELEMETRY,
    env: input.env,
    version: input.version,
    testRun: input.testRun ?? isTestRun(process.env),
  })
  const stored = await readTelemetryFile(input.telemetryFile)
  // The install id is written only when something could be reported with it.
  const installId = config ? await ensureInstallId(input.telemetryFile, stored) : undefined
  return new ErrorReporter({
    config,
    coreVersion: input.version,
    platform: input.platform,
    arch: input.arch,
    ownerScope: input.ownerScope,
    host: input.host,
    hostVersion: input.hostVersion,
    enabled: input.enabled,
    envConsent: envConsent(input.env),
    storedConsent: stored.enabled,
    installId,
    system: input.system ?? systemContext(),
    scrub: { dataFolder: input.dataFolder, homeDir: input.homeDir },
    fetch: input.fetch,
    onSendError: input.warn,
  })
}

/** What the CLI prints once per data folder, the first time the core reports because nobody said no. */
export const FIRST_RUN_NOTICE =
  'Atomic Chat core sends anonymous crash and error reports (no prompts, file paths or personal data) ' +
  'to help fix failures. Turn them off with `atomic-chat-core telemetry off` or DO_NOT_TRACK=1.\n'

/**
 * Whether to show `FIRST_RUN_NOTICE` now: reports would go out, only because nobody said no, and the
 * notice was never shown for this data folder. Showing it is recorded.
 */
export async function takeFirstRunNotice(input: {
  telemetryFile: string
  env: NodeJS.ProcessEnv
  version: string
  baked?: BakedTelemetry | undefined
  testRun?: boolean | undefined
}): Promise<boolean> {
  const config = resolveTelemetryConfig({
    baked: input.baked ?? BAKED_TELEMETRY,
    env: input.env,
    version: input.version,
    testRun: input.testRun ?? isTestRun(process.env),
  })
  if (!config) return false
  const stored = await readTelemetryFile(input.telemetryFile)
  if (
    stored.notice_shown ||
    resolveConsent({ env: envConsent(input.env), stored: stored.enabled }).source !== 'default'
  )
    return false
  await writeTelemetryFile(input.telemetryFile, { ...stored, notice_shown: true })
  return true
}
