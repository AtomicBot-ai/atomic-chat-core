import { describe, expect, it, vi } from 'vitest'
import type { FoundryManager } from '../library.js'
import { requiresMacWebGpu, withMacWebGpu } from './policy.js'

function setup() {
  const native = {
    discoverableEps: () => [
      { name: 'WebGpuExecutionProvider', registered: true },
      { name: 'CUDAExecutionProvider', registered: false },
    ],
    downloadAndRegisterEps: vi.fn(),
    registerLocalModel: vi.fn(),
    webServiceStart: vi.fn(),
    shutdown: vi.fn(),
    release: vi.fn(),
  } satisfies FoundryManager
  const ep = { register: vi.fn(async (_progress?: (percent: number) => void) => {}), release: vi.fn() }
  return { native, ep, manager: withMacWebGpu(native, ep) }
}

describe('requiresMacWebGpu', () => {
  it.each([
    ['darwin', 'arm64', '2.4.0', true],
    ['darwin', 'arm64', '2.1.0', false],
    ['darwin', 'arm64', '2.5.0', false],
    ['darwin', 'x64', '2.4.0', false],
    ['win32', 'x64', '2.4.0', false],
    ['linux', 'arm64', '2.4.0', false],
  ])('limits the registration override to %s/%s/%s: %s', (platform, arch, version, expected) => {
    expect(requiresMacWebGpu(platform, arch, version)).toBe(expected)
  })
})

describe('withMacWebGpu', () => {
  it('awaits actual registration before declaring prepared and forwards progress', async () => {
    const { native, ep, manager } = setup()
    let finish!: () => void
    ep.register.mockImplementation(
      (progress) =>
        new Promise<void>((resolve) => {
          progress?.(50)
          finish = resolve
        })
    )
    expect(manager.discoverableEps()[0]?.registered).toBe(false)
    const progress = vi.fn()
    const pending = manager.downloadAndRegisterEps(['WebGpuExecutionProvider'], progress)
    expect(progress).toHaveBeenCalledWith('WebGpuExecutionProvider', 50)
    expect(manager.discoverableEps()[0]?.registered).toBe(false)
    finish()
    await pending
    expect(manager.discoverableEps()[0]?.registered).toBe(true)
    await manager.downloadAndRegisterEps(['WebGpuExecutionProvider'])
    expect(ep.register).toHaveBeenCalledTimes(1)
    expect(native.downloadAndRegisterEps).not.toHaveBeenCalled()
  })

  it('does not mark a failed registration prepared or fall back to broken native preparation', async () => {
    const { native, ep, manager } = setup()
    ep.register.mockRejectedValue(new Error('Cached WebGPU EP failed integrity'))
    await expect(manager.downloadAndRegisterEps(['WebGpuExecutionProvider'])).rejects.toThrow(
      'failed integrity'
    )
    expect(manager.discoverableEps()[0]?.registered).toBe(false)
    expect(native.downloadAndRegisterEps).not.toHaveBeenCalled()
  })

  it('leaves unrelated accelerators alone and supports an all-EP request', async () => {
    const { native, ep, manager } = setup()
    const progress = vi.fn()
    await manager.downloadAndRegisterEps(['CUDAExecutionProvider'], progress)
    expect(ep.register).not.toHaveBeenCalled()
    expect(native.downloadAndRegisterEps).toHaveBeenLastCalledWith(['CUDAExecutionProvider'], progress)
    await manager.downloadAndRegisterEps([], progress)
    expect(ep.register).toHaveBeenCalledTimes(1)
    expect(native.downloadAndRegisterEps).toHaveBeenLastCalledWith(['CUDAExecutionProvider'], progress)
  })

  it('releases its environment after native sessions even if native release fails', () => {
    const { native, ep, manager } = setup()
    native.release.mockImplementation(() => {
      throw new Error('release failed')
    })
    expect(() => manager.release()).toThrow('release failed')
    expect(ep.release).toHaveBeenCalledTimes(1)
    expect(native.release.mock.invocationCallOrder[0]).toBeLessThan(ep.release.mock.invocationCallOrder[0]!)
  })
})
