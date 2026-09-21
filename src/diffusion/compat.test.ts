import { describe, expect, it } from 'vitest'
import type { DiffusionBackendInstallRecord } from '../contracts/index.js'
import { checkEngineCompatibility, selectModelInstall } from './compat.js'

const record = (tag: string, backendId: string): DiffusionBackendInstallRecord => ({
  tag,
  backendId,
  backend: 'metal',
  engine: 'sd-cpp',
  sha256: null,
  installedAtMs: 1,
  dir: `/engines/${tag}/${backendId}`,
})

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn()
    return undefined
  } catch (error) {
    return (error as { code?: string }).code
  }
}

describe('checkEngineCompatibility', () => {
  // The tag table of `modern_families_require_a_compatible_engine_without_switching_backends`
  // (`session.rs`, app commit ec1fd3ea7).
  it('holds Qwen Image 2.1 and Krea 2 Turbo to build 883 and fails closed on odd tags', () => {
    for (const family of ['qwen-image-2.1', 'krea-2-turbo']) {
      for (const tag of ['unknown', 'master-882-abcdef0', 'master-883', 'master-883-', 'master-x83-abc'])
        expect(
          codeOf(() => checkEngineCompatibility(family, tag)),
          `${family} ${tag}`
        ).toBe('ENGINE_UPDATE_REQUIRED')
      for (const tag of ['master-883-137f740', 'master-883-137f740-a1234567', 'master-1000-abcdef0'])
        expect(() => checkEngineCompatibility(family, tag), `${family} ${tag}`).not.toThrow()
    }
  })

  it('leaves the older families on any engine', () => {
    for (const family of ['qwen-image', 'z-image', 'flux.1', 'flux.2-klein'])
      expect(() => checkEngineCompatibility(family, 'unknown'), family).not.toThrow()
  })

  it('names the installed and the required build', () => {
    try {
      checkEngineCompatibility('qwen-image-2.1', 'master-849-d04e895')
      expect.unreachable()
    } catch (error) {
      expect((error as { toJSON(): unknown }).toJSON()).toEqual({
        code: 'ENGINE_UPDATE_REQUIRED',
        message:
          'qwen-image-2.1 requires an image engine update. Update the engine, then retry loading the model.',
        details: 'installed=master-849-d04e895; required=master-883-137f740 or newer',
      })
    }
  })
})

describe('selectModelInstall', () => {
  const old = record('master-849-d04e895', 'macos-arm64')
  const current = record('master-883-137f740', 'macos-arm64')
  const other = record('master-883-137f740', 'win-cpu-x64')

  it('asks for the engine when none is installed', () => {
    expect(codeOf(() => selectModelInstall([], 'sd-cpp', 'z-image'))).toBe('ENGINE_MISSING')
  })

  it('refuses a modern family on an old build, and never switches backends to find a new one', () => {
    expect(codeOf(() => selectModelInstall([old], 'sd-cpp', 'qwen-image-2.1'))).toBe('ENGINE_UPDATE_REQUIRED')
    expect(codeOf(() => selectModelInstall([old, other], 'sd-cpp', 'qwen-image-2.1'))).toBe(
      'ENGINE_UPDATE_REQUIRED'
    )
  })

  it('takes the first compatible install of the selected backend', () => {
    const records = [old, current]
    for (const family of ['qwen-image-2.1', 'krea-2-turbo'])
      expect(selectModelInstall(records, 'sd-cpp', family).tag, family).toBe('master-883-137f740')
    for (const family of ['qwen-image', 'z-image', 'flux.1', 'flux.2-klein'])
      expect(selectModelInstall(records, 'sd-cpp', family).tag, family).toBe('master-849-d04e895')
  })
})
