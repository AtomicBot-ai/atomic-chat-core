import type { FoundryManager } from './library.js'

const OPENVINO = 'OpenVINOExecutionProvider'

/** Only the runtime/EP combination qualified by the 2.4.0 Windows x64 archive. */
export function requiresBundledOpenVino(platform: string, arch: string, version: string): boolean {
  return platform === 'win32' && arch === 'x64' && version === '2.4.0'
}

/** Keep WinML's device discovery, but never register its incompatible OpenVINO EP on ORT 1.31. */
export function withBundledOpenVino(
  manager: FoundryManager,
  bundled: { register(): void; release(): void }
): FoundryManager {
  let registered = false
  return {
    ...manager,
    discoverableEps: () =>
      manager.discoverableEps().map((ep) => (ep.name === OPENVINO ? { ...ep, registered } : ep)),
    downloadAndRegisterEps(names, onProgress) {
      const wanted = names.length ? names : manager.discoverableEps().map((ep) => ep.name)
      if (wanted.includes(OPENVINO) && !registered) {
        bundled.register()
        registered = true
      }
      const other = wanted.filter((name) => name !== OPENVINO)
      if (other.length) return manager.downloadAndRegisterEps(other, onProgress)
    },
    release() {
      try {
        manager.release()
      } finally {
        bundled.release()
        registered = false
      }
    },
  }
}
