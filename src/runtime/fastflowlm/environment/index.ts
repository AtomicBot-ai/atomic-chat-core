export { EnvironmentManifestStore } from './store.js'
export { preparationHost } from './host.js'
export { probePreparation } from './service.js'
export { assertCurrentPlan } from './plan.js'
export { WINDOWS_NPU_DRIVER, supportedWindowsDriver } from './windows-driver.js'
export { parseEnvironment } from './manifest.js'
export {
  supportedLinuxNpuRecipe,
  matchesNpuFirmware,
  lemonadePpa,
  type LinuxNpuRecipe,
} from './linux-policy.js'
export { PreparationCoordinator } from './coordinator.js'
export { preparationBoot } from './boot.js'
export type { FlmManifest } from './manifest.js'

export { RUNTIME_MEMLOCK, RUNTIME_MEMLOCK_DIGEST, runtimeProcess } from './memlock.js'
