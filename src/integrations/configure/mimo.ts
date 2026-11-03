/**
 * MiMo Code — `mimocode.jsonc` when there is one, else `mimocode.json`, in `$MIMOCODE_HOME/config`,
 * else `~/.config/mimocode`.
 *
 * Port of `configure_mimo` in `src-tauri/src/core/system/commands.rs`. MiMo Code is a fork of
 * OpenCode and its config is OpenCode's field for field; only the directory, the file name and the
 * `$schema` URL differ. Earlier releases wrote a `$schema` MiMo does not serve; it is corrected.
 */

import type { ConfigureInput } from './registry.js'
import { registerWriter } from './registry.js'
import { mimoTarget, writeOpencodeStyleConfig } from './opencode-style.js'

export async function configureMimo(input: ConfigureInput): Promise<void> {
  return writeOpencodeStyleConfig(input, await mimoTarget(input.fs, input.env), {
    schema: 'https://mimo.xiaomi.com/mimocode/config.json',
    staleSchema: 'https://mimo.xiaomi.com/config.json',
  })
}

registerWriter('mimo', configureMimo)
