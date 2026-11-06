import { createHash } from 'node:crypto'
import { canonicalDigest } from '../../runtime/environment/index.js'
import {
  WINDOWS_NPU_DRIVER,
  parseEnvironment,
  supportedWindowsDriver,
} from '../../runtime/fastflowlm/environment/index.js'
import { CORE_VERSION } from '../../version.js'
import type { HostStepRequest } from './request-file.js'

export function npuRequestTarget(request: HostStepRequest): string | null {
  try {
    const p = request.parameters
    if (
      Object.keys(p).sort().join(',') !==
      'device_instance_id,environment_manifest,manifest_digest,manifest_id,recipe_revision,runtime_account,runtime_mode,runtime_service'
    )
      return null
    if (
      typeof p.runtime_account !== 'string' ||
      !p.runtime_account.trim() ||
      typeof p.runtime_mode !== 'string' ||
      !['desktop', 'interactive', 'user-service', 'system-service'].includes(p.runtime_mode)
    )
      return null
    if (
      p.runtime_mode.endsWith('-service')
        ? typeof p.runtime_service !== 'string' || !p.runtime_service.trim()
        : p.runtime_service !== null
    )
      return null
    const id = p.device_instance_id
    if (
      typeof id !== 'string' ||
      id.trim() !== id ||
      !/^PCI\\VEN_1022&DEV_17F0&SUBSYS_[0-9A-F]{8}&REV_(10|11|20)\\[A-F0-9&]+$/i.test(id)
    )
      return null
    const manifest = parseEnvironment(p.environment_manifest, 'windows')
    const recipe = manifest.recipes.find(
      (r) => r.recipe_id === request.recipe_id && r.revision === p.recipe_revision
    )
    if (
      request.parameters_digest !== canonicalDigest(p) ||
      manifest.manifest_id !== p.manifest_id ||
      canonicalDigest(manifest) !== p.manifest_digest ||
      recipe?.action !== 'windows.install-amd-npu' ||
      canonicalDigest(recipe) !== request.recipe_digest ||
      !supportedWindowsDriver(recipe.driver) ||
      !recipe.hardware.pci_device_ids.includes('1022:17f0')
    )
      return null
    const min = recipe.min_core_version.split('.').map(BigInt),
      core = CORE_VERSION.split('.').map(BigInt)
    const diff = min.findIndex((n, i) => n !== core[i])
    return diff >= 0 && min[diff]! > core[diff]! ? null : id
  } catch {
    return null
  }
}
export function checkNpuCab(bytes: Uint8Array): void {
  if (
    bytes.length !== WINDOWS_NPU_DRIVER.size ||
    createHash('sha256').update(bytes).digest('hex') !== WINDOWS_NPU_DRIVER.sha256
  )
    throw Error('Windows NPU CAB size or SHA-256 mismatch.')
}
type NativeNpuResult = number | 'satisfied'
export interface NpuInstallerIo {
  state: (instance: string) => Promise<'needed' | 'unsupported' | 'satisfied'>
  withStage: (run: (stage: string) => Promise<NativeNpuResult>) => Promise<NativeNpuResult>
  download: (stage: string) => Promise<void>
  verify: (stage: string, instance: string) => Promise<void>
  install: (stage: string, instance: string) => Promise<NativeNpuResult>
}
export async function installWindowsNpu(id: string, io: NpuInstallerIo) {
  const state = await io.state(id)
  if (state === 'unsupported') throw Error('Unsupported Windows NPU, host or driver state.')
  if (state === 'satisfied') return { code: 0, satisfied: true }
  const code = await io.withStage(async (stage) => {
    await io.download(stage)
    await io.verify(stage, id)
    return io.install(stage, id)
  })
  return code === 'satisfied' ? { code: 0, satisfied: true } : { code, satisfied: false }
}
