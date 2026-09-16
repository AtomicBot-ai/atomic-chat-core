/**
 * MiMo Code — `~/.config/mimocode/mimocode.json`.
 *
 * Port of `configure_mimo` in `src-tauri/src/core/system/commands.rs`. MiMo Code is a fork of
 * OpenCode and its config is OpenCode's field for field; only the directory, the file name and the
 * `$schema` URL differ.
 */

import type { ConfigureInput } from './registry.js'
import { registerWriter } from './registry.js'
import { writeOpencodeStyleConfig } from './opencode-style.js'

export function configureMimo(input: ConfigureInput): Promise<void> {
  return writeOpencodeStyleConfig(input, {
    dir: '.config/mimocode',
    file: 'mimocode.json',
    schema: 'https://mimo.xiaomi.com/config.json',
    lenient: false,
  })
}

registerWriter('mimo', configureMimo)
