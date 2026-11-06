import type { FlmRecipe } from './manifest.js'

export type LinuxNpuRecipe = Extract<FlmRecipe, { action: 'linux.install-amd-npu' }>
export const lemonadePpa = 'https://ppa.launchpadcontent.net/lemonade-team/stable/ubuntu/'
export const lemonadeFingerprint = '881CF4B40B0BFA288D6776E83BF36CFA0BD50AEC'
const ubuntuFingerprint = 'F6ECB3762474EDA9D21B7022871920D1991BC93C'
const xrtNames = ['libxrt2', 'libxrt-npu2', 'libxrt-utils', 'libxrt-utils-npu']

/** Both the planner and elevated helper must recognize the same scoped dependencies. */
export function supportedLinuxNpuRecipe(recipe: LinuxNpuRecipe, names: readonly string[]) {
  if (
    recipe.memlock_bytes !== 2147483648 ||
    !recipe.sources.every(
      (s) => s.signing_fingerprint === (s.url === lemonadePpa ? lemonadeFingerprint : ubuntuFingerprint)
    )
  )
    return false
  if (recipe.xrt === 'system' && /^flm-1\.0\.11-r[12]$/.test(recipe.qualification.build_version)) return false
  return names.every((name) => {
    const pkg = recipe.packages.find((p) => p.name === name)
    if (!pkg) return false
    const ppa = recipe.sources.find((s) => s.id === pkg.source)?.url === lemonadePpa
    if (name === 'dkms') return !ppa
    if (name.startsWith('linux-headers-'))
      return (
        !ppa &&
        recipe.platforms.every(
          (t) =>
            name === 'linux-headers-' + t.kernel_release ||
            name === 'linux-headers-' + t.kernel_release.replace(/-[a-z][a-z0-9-]*$/, '')
        )
      )
    if (!ppa) return false
    if (name === 'amdxdna-dkms') {
      // Both pinned DKMS configurations declare BUILD_EXCLUSIVE_KERNEL=6.17/18/19.
      return recipe.platforms.every(
        (t) =>
          /^6\.(17|18|19)\./.test(t.kernel_release) &&
          pkg.sha256 ===
            (t.version === '24.04'
              ? 'ea9f07d227d91878f3c660dc82b6abe4e4454b0c25d4ffd383920e6bed083893'
              : '53b8c345bb00c8253a2e13a120bff16fcd7346bc669cf65813dfac7613325a25')
      )
    }
    return recipe.xrt === 'system' && xrtNames.includes(name)
  })
}

/** Firmware selected by the driver tables and npu_7.sbin links in the two pinned DKMS archives. */
export function matchesNpuFirmware(revision: string | undefined, firmware: string) {
  if (revision === '11') return firmware === '1.1.2.65'
  return (revision === '10' || revision === '20') && firmware === '1.1.2.64'
}
