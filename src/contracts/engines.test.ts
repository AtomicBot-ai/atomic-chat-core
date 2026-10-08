import { describe, expect, expectTypeOf, it } from 'vitest'
import type { CoreEvents } from './events.js'
import {
  ENGINE_CHANGED_REASONS,
  ENGINE_IDS,
  ENGINE_UPDATE_BLOCKED_REASONS,
  ENGINE_NOT_REMOVABLE_REASONS,
} from './engines.js'
import type { EngineChangedEvent, EngineVersions } from './engines.js'
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
    ])
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
