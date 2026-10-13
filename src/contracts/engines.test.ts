import { describe, expect, expectTypeOf, it } from 'vitest'
import type { CoreEvents } from './events.js'
import {
  ENGINE_CHANGED_REASONS,
  ENGINE_IDS,
  ENGINE_KINDS,
  ENGINE_UPDATE_BLOCKED_REASONS,
  ENGINE_NOT_REMOVABLE_REASONS,
} from './engines.js'
import type { EngineChangedEvent, EngineVersions } from './engines.js'
import { MANAGED_PROVIDER_IDS } from './session.js'
import * as contracts from './index.js'

describe('engine lifecycle contracts', () => {
  it('names every engine the /engines layer answers for, in the order the desktop lists them', () => {
    expect([...ENGINE_IDS]).toEqual([
      'llamacpp-upstream',
      'llamacpp',
      'atomic-prism',
      'sd-cpp',
      'mlx',
      'tensorrt-llm',
      'vllm',
      'sglang',
    ])
  })

  it('names the system that installs each engine', () => {
    expect(Object.keys(ENGINE_KINDS)).toEqual([...ENGINE_IDS])
    // The managed engines are exactly the managed providers, in the same order (change add-sglang-runtime, D1).
    expect(ENGINE_IDS.filter((engine) => ENGINE_KINDS[engine] === 'managed')).toEqual([
      ...MANAGED_PROVIDER_IDS,
    ])
    expect([...MANAGED_PROVIDER_IDS]).toEqual(['tensorrt-llm', 'vllm', 'sglang'])
    expect(ENGINE_IDS.filter((engine) => ENGINE_KINDS[engine] === 'engine-build')).toEqual(['sd-cpp', 'mlx'])
  })

  it('keeps the reasons clients match on verbatim', () => {
    expect([...ENGINE_CHANGED_REASONS]).toEqual([
      'update',
      'activate',
      'install',
      'uninstall',
      'startup-cleanup',
      'reinstall',
    ])
    expect([...ENGINE_UPDATE_BLOCKED_REASONS]).toEqual([
      'family-change',
      'unstable',
      'requires-newer-app',
      'source-unavailable',
    ])
    expect([...ENGINE_NOT_REMOVABLE_REASONS]).toEqual(['active', 'bundled', 'in-use'])
  })

  it('puts engine:changed in the event catalog and exports the module from ./contracts', () => {
    expectTypeOf<CoreEvents['engine:changed']>().toEqualTypeOf<EngineChangedEvent>()
    expectTypeOf<EngineVersions['active_choice']>().toEqualTypeOf<'client' | 'core'>()
    expect(contracts.ENGINE_IDS).toBe(ENGINE_IDS)
  })
})
