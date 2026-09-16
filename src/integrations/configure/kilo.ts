/**
 * Kilo Code — `~/.config/kilo/kilo.jsonc`.
 *
 * Port of `configure_kilo` in `src-tauri/src/core/system/commands.rs`. The file is JSON5 (comments,
 * trailing commas), so it is read leniently or we would reject configs Kilo itself accepts; it is
 * always written back as strict JSON, which silently drops any comments the user had.
 */

import type { ConfigureInput } from './registry.js'
import { registerWriter } from './registry.js'
import { writeOpencodeStyleConfig } from './opencode-style.js'

export function configureKilo(input: ConfigureInput): Promise<void> {
  return writeOpencodeStyleConfig(input, {
    dir: '.config/kilo',
    file: 'kilo.jsonc',
    schema: 'https://app.kilo.ai/config.json',
    lenient: true,
  })
}

registerWriter('kilo', configureKilo)
