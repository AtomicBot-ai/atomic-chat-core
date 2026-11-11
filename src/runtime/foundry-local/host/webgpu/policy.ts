import type { FoundryManager } from '../library.js'

const WEBGPU = 'WebGpuExecutionProvider'

/** The native Mac EP bootstrap fails on this qualified runtime despite a compatible provider. */
export function requiresMacWebGpu(platform: string, arch: string, version: string): boolean {
  return platform === 'darwin' && arch === 'arm64' && version === '2.4.0'
}

export function withMacWebGpu(
  manager: FoundryManager,
  ep: { register(onProgress?: (percent: number) => void): Promise<void>; release(): void }
): FoundryManager {
  let registered = false
  return {
    ...manager,
    discoverableEps: () =>
      manager
        .discoverableEps()
        .map((offered) => (offered.name === WEBGPU ? { ...offered, registered } : offered)),
    async downloadAndRegisterEps(names, onProgress) {
      const wanted = names.length ? names : manager.discoverableEps().map((offered) => offered.name)
      if (wanted.includes(WEBGPU) && !registered) {
        await ep.register(onProgress ? (percent) => onProgress(WEBGPU, percent) : undefined)
        registered = true
      }
      const other = wanted.filter((name) => name !== WEBGPU)
      if (other.length) await manager.downloadAndRegisterEps(other, onProgress)
    },
    release() {
      try {
        manager.release()
      } finally {
        ep.release()
        registered = false
      }
    },
  }
}
