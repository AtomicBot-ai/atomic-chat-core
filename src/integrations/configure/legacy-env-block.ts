/**
 * OpenHands, Poolside and Muse Code read their endpoint from the environment only. Older releases
 * persisted it — a marked block in the user's shell rc, `setx` on Windows — which captured every
 * other use of the agent (a cloud key replaced by our placeholder, a dead localhost once the server
 * stops). Now the variables are set only on the process we launch (`childEnv`, and inline in the
 * app's terminal), and Connect removes the block an older release wrote: exactly the region between
 * its paired marker lines, never a user's own export of the same variable. Mirrors
 * `remove_legacy_env_agent_config` in the app's `core/system/commands.rs`; the Windows `setx`
 * variables are removed by the app alone.
 */

import type { ConfigFs } from '../config-io.js'
import type { ConfigureInput } from './registry.js'

/** The rc files an older release may have written to: which one depended on `$SHELL` back then. */
const LEGACY_RC_FILES = ['.zshenv', '.bash_profile', '.bashrc']

/** `content` without the region between (and including) the paired `marker` lines. */
export function removeMarkedEnvBlock(content: string, marker: string): string {
  const lines = content.split('\n')
  if (!lines.some((line) => line.startsWith(marker))) return content
  let inBlock = false
  return lines
    .filter((line) => {
      if (line.startsWith(marker)) {
        inBlock = !inBlock
        return false
      }
      return !inBlock
    })
    .join('\n')
}

/** Remove `marker`'s block from every rc file that has one; files without it are not touched. */
export async function removeLegacyEnvBlocks(fs: ConfigFs, marker: string): Promise<void> {
  for (const rc of LEGACY_RC_FILES) {
    const content = await fs.read(rc)
    if (content === undefined) continue
    const cleaned = removeMarkedEnvBlock(content, marker)
    if (cleaned !== content) await fs.write(rc, cleaned)
  }
}

/** The writer of an agent configured through its launch environment alone. */
export function legacyEnvAgentWriter(marker: string): (input: ConfigureInput) => Promise<void> {
  return async ({ fs, platform }) => {
    if (platform !== 'win32') await removeLegacyEnvBlocks(fs, marker)
  }
}
