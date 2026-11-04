/**
 * Which LiteRT-LM wheel the compiled core picks on this machine, restated from the spec
 * (`litert-lm-runtime`, design D7) rather than imported from `src/`, so an e2e test skips exactly
 * where the binary does not register the provider: macOS 12+ on Apple Silicon, Linux x64/arm64 with
 * glibc 2.27+, Windows x64.
 */

import { release } from 'node:os'

export function liteRtLmTestPlatform(): string | null {
  if (process.platform === 'win32') return process.arch === 'x64' ? 'win-x64' : null
  if (process.platform === 'darwin') {
    const darwin = Number.parseInt(release().split('.')[0] ?? '', 10)
    return process.arch === 'arm64' && darwin >= 21 ? 'macos-arm64' : null
  }
  if (process.platform === 'linux' && (process.arch === 'x64' || process.arch === 'arm64')) {
    const glibc = (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)
      ?.header?.glibcVersionRuntime
    const [major = 0, minor = 0] = (glibc ?? '').split('.').map((part) => Number.parseInt(part, 10))
    return major > 2 || (major === 2 && minor >= 27) ? `linux-${process.arch}` : null
  }
  return null
}
