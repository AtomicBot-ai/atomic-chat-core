import type { FlmRecipe } from './manifest.js'

/** Package identity reviewed with the matching INF and CAT in atomic-chat-conf. */
export const WINDOWS_NPU_DRIVER = Object.freeze({
  version: '32.0.203.314',
  kind: 'windows-update-cab',
  url: 'https://catalog.s.download.windowsupdate.com/c/msdownload/update/driver/drvs/2025/11/bff3a5d0-92a6-4025-b4a6-441222f89117_4c46e3c98d8f4a730543be3f6dac7f8b4ebfa4b7.cab',
  size: 21154403,
  sha256: '31343ae2698e8aa6253981d7571754124baa7d48f0d9b7280ecfa9b75708c33e',
  catalog_sha256: '1449c4e8504f74cae200f9f9a61dff3fd5cf1f217d7b551a5e8c4ebdb3d67aad',
  signer: 'Microsoft Windows Hardware Compatibility Publisher',
})
export function supportedWindowsDriver(
  driver: Extract<FlmRecipe, { action: 'windows.install-amd-npu' }>['driver']
) {
  return (Object.keys(WINDOWS_NPU_DRIVER) as (keyof typeof WINDOWS_NPU_DRIVER)[]).every(
    (key) => driver[key] === WINDOWS_NPU_DRIVER[key]
  )
}
