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
  ManagedStoreMigration,
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

/**
 * The ones set to something other than blank in `env`: the fixed ones in their order, then every
 * per-engine descriptor override (`ATOMIC_RUNTIME_DESCRIPTOR_URL_<ENGINE>`, change `add-vllm-runtime`)
 * in name order.
 */
export function sourceOverrides(env: Record<string, string | undefined>): EnvironmentSourceOverride[] {
  const perEngine = Object.keys(env)
    .filter((variable) => variable.startsWith(`${RUNTIME_DESCRIPTOR_URL_ENV}_`))
    .sort()
  return [...SOURCE_OVERRIDE_VARIABLES, ...perEngine].flatMap((variable) => {
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

/**
 * What one conf document's cache folder holds: the pointer (the first of `pointers` that names an
 * id) and every cached id. A descriptor's pointer is per engine, `latest-<engine_id>.json`.
 */
async function cacheOf(
  dir: string,
  idField: string,
  pointers: readonly string[]
): Promise<{ latest: string | null; ids: string[] }> {
  let latest: string | null = null
  for (const name of pointers) {
    try {
      const pointer = JSON.parse(await readFile(join(dir, name), 'utf8')) as Record<string, unknown>
      if (typeof pointer[idField] === 'string') {
        latest = pointer[idField] as string
        break
      }
    } catch {
      continue
    }
  }
  const ids = (await readdir(dir).catch(() => [] as string[]))
    .filter((name) => name.endsWith('.json') && name !== 'latest.json' && !name.startsWith('latest-'))
    .map((name) => decodeURIComponent(name.slice(0, -'.json'.length)))
    .sort()
  return { latest, ids }
}

export interface DocumentSourceInput {
  document: EnvironmentDocumentSource['document']
  /** A runtime descriptor's engine: its pointer is `latest-<engine_id>.json`. */
  engineId?: string
  defaultUrl: string
  /** The variables that override the source, the first one set winning. */
  variables: readonly string[]
  cacheDir: string
  idField: string
}

/** Where one conf document comes from in `env`, and what its cache holds. */
export async function documentSource(
  input: DocumentSourceInput,
  env: Record<string, string | undefined>
): Promise<EnvironmentDocumentSource> {
  const variable = input.variables.find((name) => (env[name]?.trim() ?? '') !== '')
  const override = variable === undefined ? undefined : env[variable]?.trim()
  // TensorRT-LLM's pointer was `latest.json` before change `add-vllm-runtime`; it still counts.
  const pointers =
    input.engineId === undefined
      ? ['latest.json']
      : input.engineId === 'tensorrt-llm'
        ? [`latest-${input.engineId}.json`, 'latest.json']
        : [`latest-${input.engineId}.json`]
  const cache = await cacheOf(input.cacheDir, input.idField, pointers)
  return {
    document: input.document,
    ...(input.engineId === undefined ? {} : { engine_id: input.engineId }),
    url: override ?? input.defaultUrl,
    default_url: input.defaultUrl,
    overridden_by: variable ?? null,
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
  /** The move of TensorRT-LLM's models into the managed model store (change `add-vllm-runtime`, D5). */
  storeMigration?: (() => ManagedStoreMigration | null) | undefined
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
    store_migration: input.storeMigration?.() ?? null,
  }
}
