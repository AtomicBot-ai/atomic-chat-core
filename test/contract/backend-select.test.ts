/**
 * Replays the hardware-gated backend decisions of both llama.cpp plugins against the core's port.
 *
 * `backend-select` is the upstream provider (`tauri-plugin-llamacpp-upstream/src/backend.rs`),
 * `backend-select-llamacpp` the TurboQuant fork (`tauri-plugin-llamacpp/src/backend.rs`). Every
 * case names the Rust command in `input.kind`; the tables below map each kind to the core function
 * that answers it for that provider. A Rust `Err(String)` is an `AtomicCoreError('INVALID_ARGUMENT')`
 * here, compared on its message.
 */
import { describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../../src/contracts/index.js'
import type {
  BackendFeatures,
  BackendVersion,
  BestBackendResult,
  GpuProbeInfo,
  SettingUpdateResult,
  SupportedFeatures,
  UpdateCheckResult,
} from '../../src/backend/index.js'
import {
  checkBackendForUpdates,
  checkTurboquantBackendForUpdates,
  compareTurboquantBackendsForSort,
  determineSupportedBackends,
  determineTurboquantSupportedBackends,
  findLatestTurboquantVersionForBackend,
  findLatestVersionForBackend,
  getSupportedFeatures,
  getTurboquantSupportedFeatures,
  handleSettingUpdate,
  listSupportedBackends,
  mapOldTurboquantBackendToNew,
  prioritizeBackends,
  prioritizeTurboquantBackends,
  shouldMigrateBackend,
} from '../../src/backend/index.js'
import { loadFixtureSet } from './fixtures.js'

type RocmProbeInput = { gfx_target_versions: number[]; has_runtime: boolean }

type Input =
  | {
      kind: 'features'
      os_type: string
      cpu_extensions: string[]
      gpus: GpuProbeInfo[]
      rocm_probe?: RocmProbeInput
    }
  | { kind: 'supported'; os_type: string; arch: string; features: BackendFeatures }
  | { kind: 'prioritize'; version_backends: BackendVersion[]; has_enough_gpu_memory: boolean }
  | { kind: 'merge'; remote: BackendVersion[]; local: BackendVersion[] }
  | { kind: 'latest'; version_backends: BackendVersion[]; backend_type: string }
  | { kind: 'update_check'; current: string; version_backends: BackendVersion[] }
  | { kind: 'migrate'; stored_type: string; version_backends: BackendVersion[] }
  | { kind: 'setting_update'; key: string; value: string; stored_type: string | null }

type Expected =
  | SupportedFeatures
  | string[]
  | BestBackendResult
  | BackendVersion[]
  | UpdateCheckResult
  | SettingUpdateResult
  | string
  | null
  | { error: string }

/** The core functions that answer each Rust command, per provider. */
interface Port {
  features: (input: Extract<Input, { kind: 'features' }>) => SupportedFeatures
  supported: (osType: string, arch: string, features: BackendFeatures) => string[]
  prioritize: (versionBackends: BackendVersion[], hasEnoughGpuMemory: boolean) => BestBackendResult
  merge: (remote: BackendVersion[], local: BackendVersion[]) => BackendVersion[]
  latest: (versionBackends: BackendVersion[], backendType: string) => string | null
  updateCheck: (current: string, versionBackends: BackendVersion[]) => UpdateCheckResult
  migrate: (storedType: string, versionBackends: BackendVersion[]) => string | null
  settingUpdate: (key: string, value: string, storedType: string | null) => SettingUpdateResult
}

const UPSTREAM: Port = {
  features: (input) => getSupportedFeatures(input.os_type, input.cpu_extensions, input.gpus),
  supported: determineSupportedBackends,
  prioritize: prioritizeBackends,
  merge: listSupportedBackends,
  latest: findLatestVersionForBackend,
  updateCheck: checkBackendForUpdates,
  migrate: shouldMigrateBackend,
  settingUpdate: handleSettingUpdate,
}

/**
 * The fork. `merge` is the composition `TURBOQUANT_POLICY.merge` makes in `advisor/policy.ts`.
 * `prioritize` returns only the backend string in the core; version and type are its two halves.
 * The core ports no fork-specific `shouldMigrateBackend` / `handleSettingUpdate` (the setting route
 * is deferred), so those two are the upstream bodies with the fork's mapper substituted — the same
 * composition `should_migrate_backend` and `handle_setting_update` make in the fork's `backend.rs`.
 */
const TURBOQUANT: Port = {
  features: (input) =>
    getTurboquantSupportedFeatures(input.os_type, input.cpu_extensions, input.gpus, {
      gfxTargetVersions: input.rocm_probe?.gfx_target_versions ?? [],
      hasRuntime: input.rocm_probe?.has_runtime ?? false,
    }),
  supported: determineTurboquantSupportedBackends,
  prioritize: (versionBackends, hasEnoughGpuMemory) => {
    const backendString = prioritizeTurboquantBackends(versionBackends, hasEnoughGpuMemory)
    const slash = backendString.indexOf('/')
    return {
      backend_string: backendString,
      version: backendString.slice(0, slash),
      backend_type: backendString.slice(slash + 1),
    }
  },
  merge: (remote, local) => listSupportedBackends(remote, local).sort(compareTurboquantBackendsForSort),
  latest: findLatestTurboquantVersionForBackend,
  updateCheck: checkTurboquantBackendForUpdates,
  migrate: (storedType, versionBackends) => {
    const mapped = mapOldTurboquantBackendToNew(storedType)
    if (mapped === storedType) return null
    return findLatestTurboquantVersionForBackend(versionBackends, mapped) === null ? null : mapped
  },
  settingUpdate: (key, value, storedType) => {
    // The parse (BOM, split, trim, the two error messages) is provider-independent and is the
    // upstream port; only the mapping of the parsed backend id is the fork's.
    const parsed = handleSettingUpdate(key, value, null)
    if (parsed.backend === null) return parsed
    const effective = mapOldTurboquantBackendToNew(parsed.backend)
    return {
      ...parsed,
      effective_backend_type: effective,
      backend_type_updated: storedType === null ? true : storedType !== effective,
    }
  },
}

function run(port: Port, input: Input): Expected {
  switch (input.kind) {
    case 'features':
      return port.features(input)
    case 'supported':
      return port.supported(input.os_type, input.arch, input.features)
    case 'prioritize':
      return port.prioritize(input.version_backends, input.has_enough_gpu_memory)
    case 'merge':
      return port.merge(input.remote, input.local)
    case 'latest':
      return port.latest(input.version_backends, input.backend_type)
    case 'update_check':
      return port.updateCheck(input.current, input.version_backends)
    case 'migrate':
      return port.migrate(input.stored_type, input.version_backends)
    case 'setting_update':
      return port.settingUpdate(input.key, input.value, input.stored_type)
  }
}

/**
 * The one recorded divergence (`index.comparator_notes.known_divergence`): Rust's
 * `#[serde(default)] order: u32` serialises `order: 0` for a merged entry whose input carried no
 * `order`; the core copies the entry as it is and leaves the field absent. Every reader uses
 * `order ?? 0`. The corrected expectation drops `order` from each entry whose every input
 * occurrence lacked it.
 */
function correctedMergeExpectation(input: Extract<Input, { kind: 'merge' }>, expected: BackendVersion[]) {
  const carriesOrder = new Map<string, boolean>()
  for (const entry of [...input.remote, ...input.local]) {
    const key = `${entry.version}|${entry.backend}`
    carriesOrder.set(key, (carriesOrder.get(key) ?? false) || 'order' in entry)
  }
  return expected.map((entry) => {
    if (carriesOrder.get(`${entry.version}|${entry.backend}`)) return entry
    const { order: _order, ...rest } = entry
    return rest
  })
}

for (const [set, port] of [
  ['backend-select', UPSTREAM],
  ['backend-select-llamacpp', TURBOQUANT],
] as const) {
  const { index, cases } = loadFixtureSet<Input, Expected>(set)
  const knownDivergence: Record<string, string> =
    (index as { comparator_notes?: { known_divergence?: Record<string, string> } }).comparator_notes
      ?.known_divergence ?? {}

  describe(`contract: ${set} (${index.source.file} @ ${index.source.commit.slice(0, 7)}, ${index.comparator})`, () => {
    it('has every indexed case', () => {
      expect(cases.map((c) => c.name).sort()).toEqual([...index.cases].sort())
    })

    it('records only the merge `order` shape as a known divergence', () => {
      expect(Object.keys(knownDivergence)).toEqual(['merge_remote_without_order_defaults_to_zero'])
    })

    it('covers every command kind', () => {
      const kinds = new Set(cases.map((c) => c.input.kind))
      expect([...kinds].sort()).toEqual(
        [
          'features',
          'latest',
          'merge',
          'migrate',
          'prioritize',
          'setting_update',
          'supported',
          'update_check',
        ].sort()
      )
    })

    it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
      if (c.expected !== null && typeof c.expected === 'object' && 'error' in c.expected) {
        try {
          run(port, c.input)
          expect.unreachable('expected an error')
        } catch (e) {
          expect(e).toBeInstanceOf(AtomicCoreError)
          expect((e as AtomicCoreError).code).toBe('INVALID_ARGUMENT')
          expect((e as AtomicCoreError).message).toBe(c.expected.error)
        }
      } else if (c.name in knownDivergence && c.input.kind === 'merge') {
        expect(run(port, c.input)).toEqual(correctedMergeExpectation(c.input, c.expected as BackendVersion[]))
      } else {
        expect(run(port, c.input)).toEqual(c.expected)
      }
    })
  })
}
