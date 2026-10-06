/**
 * What a person who is stuck can see and send (2026-10-06): a Windows on Arm test machine kept two
 * commit-pinned conf URLs in its user environment, so its core read a superseded descriptor and
 * blocked the setup on a driver floor conf had already lowered — and nothing on screen or in the log
 * said where the descriptor came from. Diagnosing it took photos of PowerShell output.
 *
 * Two pieces live here, both read-only. `sourceOverrides` names the environment variables that move a
 * managed-runtime source, for the snapshot (`EnvironmentSnapshot.source_overrides`), so the app can
 * say so on the provider page. `buildEnvironmentDiagnostics` assembles the report behind
 * `GET /environments/:environmentId/diagnostics`: the snapshot, every conf document's source and
 * cache, every operation on disk, and the managed-runtime code's recent warnings.
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MANAGED_ROOT_ENV } from '../../config/index.js'
import type {
  EnvironmentDiagnostics,
  EnvironmentDocumentSource,
  EnvironmentOperationSummary,
  EnvironmentSnapshot,
  EnvironmentSourceOverride,
} from '../../contracts/index.js'
import { RUNTIME_DESCRIPTOR_URL_ENV } from './descriptor-provider.js'
import { ENVIRONMENT_MANIFEST_URL_ENV } from './environment-manifest-provider.js'
import type { PersistedOperation } from './store.js'

/** The variables that move where managed runtimes read conf or keep their state. */
export const SOURCE_OVERRIDE_VARIABLES: readonly string[] = [
  RUNTIME_DESCRIPTOR_URL_ENV,
  ENVIRONMENT_MANIFEST_URL_ENV,
  MANAGED_ROOT_ENV,
]

/** The ones set to something other than blank in `env`, in a fixed order. */
export function sourceOverrides(env: Record<string, string | undefined>): EnvironmentSourceOverride[] {
  return SOURCE_OVERRIDE_VARIABLES.flatMap((variable) => {
    const value = env[variable]?.trim()
    return value === undefined || value === '' ? [] : [{ variable, value }]
  })
}

/** An operation on disk, reduced to what explains it. */
export function summarizeOperation(record: PersistedOperation): EnvironmentOperationSummary {
  const operation = record.machine.operation
  return {
    operation_id: operation.operation_id,
    kind: operation.kind,
    target: operation.target,
    phase: operation.phase,
    checkpoint: record.machine.checkpoint ?? null,
    revision: operation.revision,
    consented_descriptor_id: record.machine.consented?.descriptor_id ?? null,
    plan_descriptor_id: record.requirement_plan?.descriptor_id ?? null,
    error: operation.error,
  }
}

/** What one conf document's cache folder holds: the `latest.json` pointer and every cached id. */
async function cacheOf(dir: string, idField: string): Promise<{ latest: string | null; ids: string[] }> {
  let latest: string | null = null
  try {
    const pointer = JSON.parse(await readFile(join(dir, 'latest.json'), 'utf8')) as Record<string, unknown>
    if (typeof pointer[idField] === 'string') latest = pointer[idField] as string
  } catch {
    latest = null
  }
  const ids = (await readdir(dir).catch(() => [] as string[]))
    .filter((name) => name.endsWith('.json') && name !== 'latest.json')
    .map((name) => decodeURIComponent(name.slice(0, -'.json'.length)))
    .sort()
  return { latest, ids }
}

export interface DocumentSourceInput {
  document: EnvironmentDocumentSource['document']
  defaultUrl: string
  variable: string
  cacheDir: string
  idField: string
}

/** Where one conf document comes from in `env`, and what its cache holds. */
export async function documentSource(
  input: DocumentSourceInput,
  env: Record<string, string | undefined>
): Promise<EnvironmentDocumentSource> {
  const override = env[input.variable]?.trim()
  const overridden = override !== undefined && override !== ''
  const cache = await cacheOf(input.cacheDir, input.idField)
  return {
    document: input.document,
    url: overridden ? override : input.defaultUrl,
    default_url: input.defaultUrl,
    overridden_by: overridden ? input.variable : null,
    latest_cached_id: cache.latest,
    cached_ids: cache.ids,
  }
}

export interface DiagnosticsInput {
  now: () => Date
  coreVersion: string
  platform: string
  arch: string
  environment: EnvironmentSnapshot | null
  env: Record<string, string | undefined>
  documents: readonly DocumentSourceInput[]
  operations: () => Promise<PersistedOperation[]>
  recentWarnings: () => string[]
}

export async function buildEnvironmentDiagnostics(input: DiagnosticsInput): Promise<EnvironmentDiagnostics> {
  const sources = await Promise.all(input.documents.map((document) => documentSource(document, input.env)))
  // A corrupt record must not take the whole report down: the report is what explains it.
  const records = await input.operations().catch(() => [] as PersistedOperation[])
  return {
    generated_at: input.now().toISOString(),
    core_version: input.coreVersion,
    platform: input.platform,
    arch: input.arch,
    environment: input.environment,
    sources,
    operations: records.map(summarizeOperation),
    recent_warnings: input.recentWarnings(),
  }
}
