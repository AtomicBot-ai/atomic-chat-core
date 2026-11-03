/**
 * One-time moves of stored values from a default core no longer ships to the new one.
 *
 * `settings.json` stores every provider value, defaults included (`SettingsStore.open` writes a fresh
 * file in full), so a changed schema default would otherwise reach new installs only. A migration
 * moves a stored value that still equals the old default to the new one, once: its id is then recorded
 * under `state.default_migrations`, and a value the user sets afterwards — the old default included —
 * stays. A value the user had already moved off the old default is never touched; one the user had
 * chosen to be exactly the old default cannot be told apart from it and moves too, as the app's own
 * default migrations (`migrateFitDefaultOn`) have always done.
 */
import type { LocalProviderId } from '../contracts/index.js'
import { jsonEqual } from './import.js'

export interface DefaultMigration {
  id: string
  providers: readonly LocalProviderId[]
  key: string
  from: unknown
  to: unknown
}

const LLAMACPP: readonly LocalProviderId[] = ['llamacpp-upstream', 'llamacpp', 'atomic-prism']

/** Integrations audit 2026-11-03 (S2, S3, X6, P3); the reasons sit beside each new default in code. */
export const DEFAULT_MIGRATIONS: readonly DefaultMigration[] = [
  // Two slots over one unified KV pool (args.ts): side requests no longer wait behind an agent turn.
  { id: 'llamacpp-parallel-2', providers: LLAMACPP, key: 'parallel', from: 1, to: 2 },
  // llama.cpp always batched continuously; the setting now says so, and its "off" is sent (args.ts).
  { id: 'llamacpp-cont-batching-on', providers: LLAMACPP, key: 'cont_batching', from: false, to: true },
  // 0 is the automatic answer cap (generation-limits.ts); -1 stays "no limit" for whoever sets it.
  { id: 'llamacpp-n-predict-auto', providers: LLAMACPP, key: 'n_predict', from: -1, to: 0 },
  // 0 is the automatic window and request count of a managed engine (auto-limits.ts).
  { id: 'vllm-auto-context', providers: ['vllm'], key: 'context_length', from: 8192, to: 0 },
  { id: 'vllm-auto-seqs', providers: ['vllm'], key: 'max_num_seqs', from: 1, to: 0 },
  { id: 'sglang-auto-context', providers: ['sglang'], key: 'context_length', from: 8192, to: 0 },
  { id: 'sglang-auto-requests', providers: ['sglang'], key: 'max_running_requests', from: 1, to: 0 },
]

/** Where the ids of the migrations already applied are kept. */
export const DEFAULT_MIGRATIONS_STATE_KEY = 'default_migrations'

export interface DefaultMigrationOutcome {
  /** `<provider>.<key>` of every value moved. */
  moved: string[]
  /** Ids recorded now; non-empty means the document changed even when no value did. */
  recorded: string[]
}

/**
 * Apply every migration not yet recorded to `providers`, and record it. Mutates both arguments;
 * `state` is the document's `state` section.
 */
export function applyDefaultMigrations(
  providers: Record<string, unknown>,
  state: Record<string, unknown>,
  migrations: readonly DefaultMigration[] = DEFAULT_MIGRATIONS
): DefaultMigrationOutcome {
  const raw = state[DEFAULT_MIGRATIONS_STATE_KEY]
  const done = new Set(Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : [])
  const outcome: DefaultMigrationOutcome = { moved: [], recorded: [] }
  for (const migration of migrations) {
    if (done.has(migration.id)) continue
    for (const provider of migration.providers) {
      const section = providers[provider]
      if (typeof section !== 'object' || section === null || Array.isArray(section)) continue
      const values = section as Record<string, unknown>
      if (migration.key in values && jsonEqual(values[migration.key], migration.from)) {
        values[migration.key] = structuredClone(migration.to)
        outcome.moved.push(`${provider}.${migration.key}`)
      }
    }
    done.add(migration.id)
    outcome.recorded.push(migration.id)
  }
  if (outcome.recorded.length > 0) state[DEFAULT_MIGRATIONS_STATE_KEY] = [...done]
  return outcome
}
