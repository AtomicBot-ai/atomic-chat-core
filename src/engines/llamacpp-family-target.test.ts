import { expect, it } from 'vitest'
import { LlamacppEngine } from './llamacpp.js'
import type { LlamacppEngineDeps } from './llamacpp.js'

/**
 * The "Latest <variant>" dropdown uses minor-less family ids (`win-cuda-13-x64`) while the release
 * catalog publishes concrete assets (`win-cuda-13.5-x64`). An update that names the family must
 * resolve to the newest concrete build, as `resolveLatestVersionBackend` does everywhere else.
 */
const available = [
  { version: 'b12244', backend: 'win-cuda-13.5-x64' },
  { version: 'b12244', backend: 'win-cpu-x64' },
  { version: 'b12100', backend: 'win-cuda-13.3-x64' },
]

it('resolves a minor-less CUDA family variant to the newest concrete catalog build', async () => {
  const installed: string[] = []
  const deps = {
    engine: 'llamacpp-upstream',
    backends: {
      operate: async (_kind: string, fn: (operation: { kind: string }) => Promise<unknown>) =>
        fn({ kind: _kind }),
      exclusive: (fn: () => Promise<unknown>) => fn(),
      install: async (version: string, variant: string) => {
        installed.push(`${version}/${variant}`)
        return { version, backend: variant, installed: true, path: '' }
      },
      listInstalled: async () => [],
      bundledPack: async () => null,
      busyChecker: async () => async () => false,
      remove: async () => false,
    },
    advisor: {
      catalog: async () => ({ provider: 'llamacpp-upstream', available, source: 'live' }),
      checkUpdates: async () => ({
        provider: 'llamacpp-upstream',
        current: 'b12100/win-cuda-13.3-x64',
        current_kind: 'concrete',
        update_needed: true,
        new_version: 'b12244',
        target_backend: 'b12244/win-cuda-13.5-x64',
        same_family: true,
        offer: 'b12244/win-cuda-13.5-x64',
      }),
    },
    currentVersionBackend: () => 'b12100/win-cuda-13.3-x64',
    selectVersionBackend: async () => {},
    unloadSessions: async () => {},
    emit: () => {},
  } as unknown as LlamacppEngineDeps

  const result = await new LlamacppEngine(deps).update({
    task_id: 'engine-update-llamacpp-upstream',
    target: { variant: 'win-cuda-13-x64' },
  })

  expect(result).toMatchObject({
    updated: true,
    active: { version: 'b12244', variant: 'win-cuda-13.5-x64' },
  })
  expect(installed).toEqual(['b12244/win-cuda-13.5-x64'])
})
