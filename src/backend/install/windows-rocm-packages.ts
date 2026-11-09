/** Pinned AMD wheel sources for the ABI named by an upstream Windows HIP pack. */
import { AtomicCoreError, type GpuProbeInfo } from '../../contracts/index.js'
import { AMD_ROCM_WINDOWS_PCI_IDS } from '../select/index.js'

export interface RocmPackage {
  name: string
  url: string
  sha256?: string
  size?: number
}
const BASE = 'https://stable.repo.amd.com/rocm/core/whl-next'
export const WINDOWS_ROCM_VERSION = '10.0.0'

export function windowsRocmPackages(backend: string, gpus: readonly GpuProbeInfo[]): RocmPackage[] {
  if (backend !== 'win-rocm-10.0-x64')
    throw new AtomicCoreError(
      'ENGINE_BINARY_BROKEN',
      `No supported runtime source for ${backend}. Select a ROCm 10.0 build or Vulkan.`
    )
  const targets = [
    ...new Set(
      gpus
        .filter((gpu) => gpu.vendor === 'AMD')
        .flatMap((gpu) => {
          const gfx = AMD_ROCM_WINDOWS_PCI_IDS.find(([id]) => id === gpu.vulkan_info?.device_id)?.[1]
          return gfx ? [gfx] : []
        })
    ),
  ].sort()
  if (!targets.length)
    throw new AtomicCoreError(
      'GPU_BACKEND_INCOMPATIBLE',
      'The AMD GPU architecture is unknown. Select Vulkan or refresh hardware detection.'
    )
  return ['rocm_sdk_libraries', ...targets.map((gfx) => `rocm_sdk_device_${gfx}`)].map((name) => ({
    name,
    url: `${BASE}/${name.replaceAll('_', '-')}/${name}-${WINDOWS_ROCM_VERSION}-py3-none-win_amd64.whl`,
    // SHA-256 of AMD's published files, independently pinned where reviewed. Every wheel's
    // RECORD is also checked once at installation; AMD's index supplies no archive digests.
    ...(name === 'rocm_sdk_libraries'
      ? {
          sha256: 'bfc7a1bd3b6050fb4d36d8ac2eea80d3afd70c5604a29142463d6cb890fc73bf',
          size: 116831755,
        }
      : name === 'rocm_sdk_device_gfx1152'
        ? {
            sha256: '88db4e79f31bef68bf8cb321fb83704dda6d11ad6da8dcfbdc8660f077c7195c',
            size: 134480596,
          }
        : {}),
  }))
}
