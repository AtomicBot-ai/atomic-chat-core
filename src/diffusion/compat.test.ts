import { describe, expect, it } from 'vitest'
import type { DiffusionBackendInstallRecord } from '../contracts/index.js'
import { checkEngineCompatibility, sdcppBuildOf, selectModelInstall } from './compat.js'

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

describe('sdcppBuildOf', () => {
  it('reads the build of upstream, fork and mirror tags, and nothing else', () => {
    expect(sdcppBuildOf('master-849-d04e895')).toBe(849)
    expect(sdcppBuildOf('master-1088-32d516c-af0b1071')).toBe(1088)
    for (const tag of ['unknown', 'master-883', 'master-883-', 'master-x83-abc', 'master-137f740', 'b1088-x'])
      expect(sdcppBuildOf(tag), tag).toBeUndefined()
  })
})

describe('checkEngineCompatibility', () => {
  // The tag table of `modern_families_require_a_compatible_engine_without_switching_backends`
  // (`session.rs`, app commit ec1fd3ea7).
  it('holds Qwen Image 2.1, its Turbo and Krea 2 Turbo to build 883 and fails closed on odd tags', () => {
    for (const family of ['qwen-image-2.1', 'qwen-image-2.1-turbo', 'krea-2-turbo']) {
      for (const tag of ['unknown', 'master-882-abcdef0', 'master-883', 'master-883-', 'master-x83-abc'])
        expect(
          codeOf(() => checkEngineCompatibility(family, tag)),
          `${family} ${tag}`
        ).toBe('ENGINE_UPDATE_REQUIRED')
      for (const tag of ['master-883-137f740', 'master-883-137f740-a1234567', 'master-1000-abcdef0'])
        expect(() => checkEngineCompatibility(family, tag), `${family} ${tag}`).not.toThrow()
    }
  })

  it('holds FLUX.3 Klein to build 968, the one that added it upstream', () => {
    for (const tag of ['unknown', 'master-883-137f740', 'master-883-137f740-a36f1b1a', 'master-967-e47426c'])
      expect(
        codeOf(() => checkEngineCompatibility('flux.3-klein', tag)),
        tag
      ).toBe('ENGINE_UPDATE_REQUIRED')
    for (const tag of ['master-968-8cd731e', 'master-975-95b3090', 'master-975-95b3090-a1234567'])
      expect(() => checkEngineCompatibility('flux.3-klein', tag), tag).not.toThrow()
    try {
      checkEngineCompatibility('flux.3-klein', 'master-883-137f740-a36f1b1a')
      expect.unreachable()
    } catch (error) {
      expect((error as { details?: string }).details).toBe(
        'installed=master-883-137f740-a36f1b1a; required=master-968-8cd731e or newer'
      )
    }
  })

  it('holds MiniMax-H3-Image and P-H3-Image to build 1088, the one that added MiniMax upstream', () => {
    // P-H3-Image arrived in 1048 (#2272) but shares the H3 floor: 1088 is the build it was checked on.
    for (const family of ['minimax-h3-image', 'p-h3-image']) {
      for (const tag of [
        'unknown',
        'master-968-8cd731e',
        'master-1048-3e92bf9',
        'master-1079-a3c49b1',
        'master-1087-f8417d0',
      ])
        expect(
          codeOf(() => checkEngineCompatibility(family, tag)),
          `${family} ${tag}`
        ).toBe('ENGINE_UPDATE_REQUIRED')
      for (const tag of ['master-1088-32d516c', 'master-1088-32d516c-a1234567', 'master-1100-abcdef0'])
        expect(() => checkEngineCompatibility(family, tag), `${family} ${tag}`).not.toThrow()
      try {
        checkEngineCompatibility(family, 'master-1028-37bc88b-a5f9a63b')
        expect.unreachable()
      } catch (error) {
        expect((error as { details?: string }).details).toBe(
          'installed=master-1028-37bc88b-a5f9a63b; required=master-1088-32d516c or newer'
        )
      }
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
    for (const family of ['qwen-image-2.1', 'qwen-image-2.1-turbo', 'krea-2-turbo'])
      expect(selectModelInstall(records, 'sd-cpp', family).tag, family).toBe('master-883-137f740')
    for (const family of ['qwen-image', 'z-image', 'flux.1', 'flux.2-klein'])
      expect(selectModelInstall(records, 'sd-cpp', family).tag, family).toBe('master-849-d04e895')
  })

  it('serves FLUX.3 Klein only from a build of 968 or newer', () => {
    const flux3 = record('master-975-95b3090', 'macos-arm64')
    expect(codeOf(() => selectModelInstall([current, old], 'sd-cpp', 'flux.3-klein'))).toBe(
      'ENGINE_UPDATE_REQUIRED'
    )
    expect(selectModelInstall([current, flux3], 'sd-cpp', 'flux.3-klein').tag).toBe('master-975-95b3090')
    expect(selectModelInstall([current, flux3], 'sd-cpp', 'qwen-image-2.1').tag).toBe('master-883-137f740')
  })

  it('serves MiniMax-H3-Image only from a build of 1088 or newer', () => {
    const flux3 = record('master-975-95b3090', 'macos-arm64')
    const h3 = record('master-1088-32d516c', 'macos-arm64')
    expect(codeOf(() => selectModelInstall([flux3, current], 'sd-cpp', 'minimax-h3-image'))).toBe(
      'ENGINE_UPDATE_REQUIRED'
    )
    expect(selectModelInstall([h3, flux3, current], 'sd-cpp', 'minimax-h3-image').tag).toBe(
      'master-1088-32d516c'
    )
    expect(selectModelInstall([h3, flux3, current], 'sd-cpp', 'flux.3-klein').tag).toBe('master-1088-32d516c')
  })
})
