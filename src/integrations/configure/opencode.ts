/**
 * OpenCode — `~/.config/opencode/opencode.json`.
 *
 * Port of `configure_opencode` in `src-tauri/src/core/system/commands.rs`. Strict JSON: a file the
 * parser rejects is a hard error and nothing is written, so a typo in the user's config is
 * reported instead of being overwritten.
 */

import type { ConfigureInput } from './registry.js'
import { registerWriter } from './registry.js'
import { writeOpencodeStyleConfig } from './opencode-style.js'

export function configureOpencode(input: ConfigureInput): Promise<void> {
  return writeOpencodeStyleConfig(input, {
    dir: '.config/opencode',
    file: 'opencode.json',
    schema: 'https://opencode.ai/config.json',
    lenient: false,
  })
}

registerWriter('opencode', configureOpencode)
