/**
 * OpenCode — `opencode.jsonc` when there is one, else `opencode.json`, in `$OPENCODE_CONFIG_DIR`,
 * else the `$OPENCODE_CONFIG` file, else `~/.config/opencode`.
 *
 * Port of `configure_opencode` in `src-tauri/src/core/system/commands.rs`. A file the parser rejects
 * is a hard error and nothing is written, so a typo in the user's config is reported instead of
 * being overwritten.
 */

import type { ConfigureInput } from './registry.js'
import { registerWriter } from './registry.js'
import { opencodeTarget, writeOpencodeStyleConfig } from './opencode-style.js'

export async function configureOpencode(input: ConfigureInput): Promise<void> {
  return writeOpencodeStyleConfig(input, await opencodeTarget(input.fs, input.env), {
    schema: 'https://opencode.ai/config.json',
  })
}

registerWriter('opencode', configureOpencode)
