/**
 * Kilo Code — `kilo.jsonc` in `$KILO_CONFIG_DIR`, else `~/.config/kilo`.
 *
 * Port of `configure_kilo` in `src-tauri/src/core/system/commands.rs`. Kilo opens on the model it
 * last used for its agent before the one this config selects, so `launch` also starts it with
 * `--model atomic/<id>` (`runArgsFor` in the catalog).
 */

import type { ConfigureInput } from './registry.js'
import { registerWriter } from './registry.js'
import { kiloTarget, writeOpencodeStyleConfig } from './opencode-style.js'

export function configureKilo(input: ConfigureInput): Promise<void> {
  return writeOpencodeStyleConfig(input, kiloTarget(input.env), {
    schema: 'https://app.kilo.ai/config.json',
  })
}

registerWriter('kilo', configureKilo)
