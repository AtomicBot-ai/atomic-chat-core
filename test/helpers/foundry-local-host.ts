/**
 * Which Foundry Local archive the compiled core picks on this machine, restated from the spec
 * ("Провайдер регистрируется только на поддерживаемых платформах") rather than imported from `src/`,
 * so an e2e test skips exactly where the binary does not register the provider: macOS 15+ on Apple
 * Silicon, Linux x64/arm64 with glibc 2.28+, Windows x64/arm64.
 */

import { release } from 'node:os'

export function foundryLocalTestPlatform(): string | null {
  const arch = process.arch === 'arm64' || process.arch === 'x64' ? process.arch : null
  if (!arch) return null
  if (process.platform === 'win32') return `win-${arch}`
  if (process.platform === 'darwin') {
    const darwin = Number.parseInt(release().split('.')[0] ?? '', 10)
    return arch === 'arm64' && darwin >= 24 ? 'macos-arm64' : null
  }
  if (process.platform === 'linux') {
    const glibc = (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)
      ?.header?.glibcVersionRuntime
    const [major = 0, minor = 0] = (glibc ?? '').split('.').map((part) => Number.parseInt(part, 10))
    return major > 2 || (major === 2 && minor >= 28) ? `linux-${arch}` : null
  }
  return null
}
