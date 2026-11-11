import { describe, expect, it, vi } from 'vitest'
import type { FoundryManager } from './library.js'
import { requiresBundledOpenVino, withBundledOpenVino } from './openvino.js'

describe('requiresBundledOpenVino', () => {
  it.each([
    ['win32', 'x64', '2.4.0', true],
    ['win32', 'x64', '2.1.0', false],
    ['win32', 'arm64', '2.4.0', false],
    ['linux', 'x64', '2.4.0', false],
    ['darwin', 'arm64', '2.4.0', false],
    ['win32', 'x64', '2.5.0', false],
  ])('%s/%s/%s requires the qualified Intel bundle: %s', (platform, arch, version, expected) => {
    expect(requiresBundledOpenVino(platform, arch, version)).toBe(expected)
  })
})

function setup() {
  const native = {
    discoverableEps: vi.fn(() => [
      { name: 'OpenVINOExecutionProvider', registered: true },
      { name: 'CUDAExecutionProvider', registered: false },
    ]),
    downloadAndRegisterEps: vi.fn(),
    registerLocalModel: vi.fn(),
    webServiceStart: vi.fn(),
    shutdown: vi.fn(),
    release: vi.fn(),
  } satisfies FoundryManager
  const bundled = { register: vi.fn(), release: vi.fn() }
  return { native, bundled, manager: withBundledOpenVino(native, bundled) }
}

describe('withBundledOpenVino', () => {
  it('does not accept the system registration as preparation for the bundled EP', () => {
    const { manager, bundled } = setup()
    expect(manager.discoverableEps()[0]).toEqual({ name: 'OpenVINOExecutionProvider', registered: false })
    expect(bundled.register).not.toHaveBeenCalled()
  })

  it('registers the bundled EP once, avoiding the incompatible WinML EP', () => {
    const { manager, native, bundled } = setup()
    manager.downloadAndRegisterEps(['OpenVINOExecutionProvider'])
    manager.downloadAndRegisterEps(['OpenVINOExecutionProvider'])
    expect(bundled.register).toHaveBeenCalledTimes(1)
    expect(native.downloadAndRegisterEps).not.toHaveBeenCalled()
    expect(manager.discoverableEps()[0]?.registered).toBe(true)
  })

  it('leaves a failed bundled registration unprepared, without a system fallback', () => {
    const { manager, native, bundled } = setup()
    bundled.register.mockImplementation(() => {
      throw new Error('Intel EP dependency missing')
    })
    expect(() => manager.downloadAndRegisterEps(['OpenVINOExecutionProvider'])).toThrow(
      'Intel EP dependency missing'
    )
    expect(manager.discoverableEps()[0]?.registered).toBe(false)
    expect(native.downloadAndRegisterEps).not.toHaveBeenCalled()
  })

  it('preserves other EPs and their progress callback, including an all-EP request', () => {
    const { manager, native, bundled } = setup()
    const progress = vi.fn()
    manager.downloadAndRegisterEps(['CUDAExecutionProvider'], progress)
    expect(bundled.register).not.toHaveBeenCalled()
    expect(native.downloadAndRegisterEps).toHaveBeenLastCalledWith(['CUDAExecutionProvider'], progress)
    manager.downloadAndRegisterEps([], progress)
    expect(bundled.register).toHaveBeenCalledTimes(1)
    expect(native.downloadAndRegisterEps).toHaveBeenLastCalledWith(['CUDAExecutionProvider'], progress)
  })

  it('releases the ORT environment after the native manager, even if release throws', () => {
    const { manager, native, bundled } = setup()
    native.release.mockImplementation(() => {
      throw new Error('native release failed')
    })
    expect(() => manager.release()).toThrow('native release failed')
    expect(bundled.release).toHaveBeenCalledTimes(1)
    expect(native.release.mock.invocationCallOrder[0]).toBeLessThan(
      bundled.release.mock.invocationCallOrder[0]!
    )
  })
})
