/**
 * An in-memory `SettingsControl` for control-server tests.
 *
 * The merge itself is covered where it lives (`src/settings/import.test.ts` and the store's tests);
 * what the route tests need is something that records what it was asked and can be told to answer
 * with a conflict, so the routes' own behaviour — status codes, argument passing, error shapes — is
 * what is under test rather than the store's.
 */

import type { SettingsControl } from '../../src/server/control.js'
import type { ImportResult, MigrationRecord, ProviderValues, UpdateResult } from '../../src/settings/index.js'

export interface FakeSettingsControl extends SettingsControl {
  values: Record<string, ProviderValues>
  migrations: Record<string, MigrationRecord>
  calls: string[]
  /** When set, the next import answers with this instead of applying anything. */
  nextImport?: ImportResult
}

export function fakeSettingsControl(initial: Record<string, ProviderValues> = {}): FakeSettingsControl {
  const fake: FakeSettingsControl = {
    values: structuredClone(initial),
    migrations: {},
    calls: [],
    revision: () => 7,
    get: (provider) => {
      fake.calls.push(`get ${provider}`)
      return fake.values[provider] ?? {}
    },
    migration: (scope) => {
      fake.calls.push(`migration ${scope}`)
      return fake.migrations[scope] ?? null
    },
    update: async (provider, patch, options): Promise<UpdateResult> => {
      fake.calls.push(
        `update ${provider} ${JSON.stringify(patch)} expected=${options.expectedRevision ?? 'any'}`
      )
      fake.values[provider] = { ...(fake.values[provider] ?? {}), ...patch }
      return { revision: 8, changed: Object.keys(patch) }
    },
    importProvider: async (provider, values, options): Promise<ImportResult> => {
      fake.calls.push(
        `import ${provider} ${JSON.stringify(values)} resolutions=${JSON.stringify(
          options.resolutions ?? {}
        )} expected=${options.expectedRevision ?? 'any'}`
      )
      if (fake.nextImport) return fake.nextImport
      fake.values[provider] = { ...(fake.values[provider] ?? {}), ...values }
      return { status: 'imported', applied: Object.keys(values), conflicts: [], revision: 8 }
    },
    acknowledge: async (scope, revision): Promise<UpdateResult> => {
      fake.calls.push(`acknowledge ${scope} ${revision}`)
      return { revision, changed: [`migrations.${scope}.acknowledged_revision`] }
    },
  }
  return fake
}
