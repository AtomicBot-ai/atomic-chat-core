/**
 * Codex CLI — `~/.codex/config.toml`.
 *
 * Port of `configure_codex` in `src-tauri/src/core/system/commands.rs`. This is the only writer that
 * edits TOML, and it does it textually rather than by parsing: the file is the user's, so the two
 * regions we own are delimited by managed markers and everything between them is left alone.
 *
 * Two regions, not one, because Codex 0.135+ makes Atomic the default provider through the bare
 * root keys `model` / `model_provider`, and bare TOML keys must precede every `[table]`. So a head
 * block goes at the very top, the user's content follows, and the `[model_providers.atomic]` table
 * goes last. Rerunning strips both regions first, which is why a rerun is idempotent.
 *
 * The user's content is `trimEnd`-ed but never trimmed at the start: leading blank lines left by
 * stripping a previous head block are part of the recorded output.
 */

import { ATOMIC_MANAGED_BEGIN, ATOMIC_MANAGED_END } from '../config-io.js'
import { stripAtomicManagedBlock, tomlBasicStringEscape } from '../config-io.js'
import type { ConfigureInput } from './registry.js'
import { registerWriter } from './registry.js'

const DIR = '.codex'
const PATH = `${DIR}/config.toml`

export async function configureCodex(input: ConfigureInput): Promise<void> {
  const { fs, apiUrl, model, apiKey } = input
  await fs.mkdirp(DIR)

  const existing = (await fs.read(PATH)) ?? ''
  const cleaned = stripAtomicManagedBlock(existing)

  const head =
    `${ATOMIC_MANAGED_BEGIN}\n` +
    `model = "${tomlBasicStringEscape(model)}"\n` +
    `model_provider = "atomic"\n` +
    `${ATOMIC_MANAGED_END}\n`

  // Codex reads the secret from the env var named here, never inline — so with no key there is no
  // `env_key` line at all, rather than a placeholder.
  const envKeyLine = apiKey === '' ? '' : `env_key = "ATOMIC_CHAT_API_KEY"\n`
  const block =
    `${ATOMIC_MANAGED_BEGIN}\n` +
    `[model_providers.atomic]\n` +
    `name = "Atomic Chat"\n` +
    `base_url = "${tomlBasicStringEscape(apiUrl)}"\n` +
    envKeyLine +
    `${ATOMIC_MANAGED_END}\n`

  const content = cleaned.trim() === '' ? `${head}\n${block}` : `${head}\n${cleaned.trimEnd()}\n${block}`

  await fs.write(PATH, content)
}

registerWriter('codex', configureCodex)
