/**
 * Claude Code — `~/.claude/settings.json`.
 *
 * Port of `configure_claude_code` in `src-tauri/src/core/system/commands.rs`. Claude Code takes its
 * endpoint from environment variables that its settings file can carry, so pointing it at a local
 * model is an upsert into that file's `env` map plus the top-level `model` setting.
 *
 * Claude Code appends its own `/v1`, so `apiUrl` here is the bare `host:port` (the catalog marks
 * this agent `endpointWithPrefix: false`).
 *
 * An empty model means "nothing is loaded". `cli::integrations::configure` turns it into `None` for
 * this agent, and the writer then leaves every model key alone — it neither writes them nor removes
 * ones an earlier run left behind, so a rerun without a model keeps pointing at the last one.
 */

import { AtomicCoreError } from '../../contracts/index.js'
import { canonicalJson, keyOr, parseJsonStrict } from '../config-io.js'
import { asJsonObject } from './json-tree.js'
import type { ConfigureInput } from './registry.js'
import { registerWriter } from './registry.js'

const DIR = '.claude'
const PATH = `${DIR}/settings.json`

export async function configureClaudeCode(input: ConfigureInput): Promise<void> {
  const { fs, apiUrl, model, apiKey } = input
  await fs.mkdirp(DIR)

  const text = await fs.read(PATH)
  const parsed = text === undefined ? {} : parseJsonStrict(text, fs.absolute(PATH))
  const root = asJsonObject(parsed)
  if (!root) throw new AtomicCoreError('IO_ERROR', 'settings.json is not a JSON object')

  const env = asJsonObject(root['env']) ?? {}
  root['env'] = env
  env['ANTHROPIC_BASE_URL'] = apiUrl
  env['ANTHROPIC_AUTH_TOKEN'] = keyOr(apiKey, 'atomic')

  if (model !== '') {
    // ANTHROPIC_MODEL overrides the `model` setting; the tier aliases make every Opus/Sonnet/Haiku
    // request route to the single local model too.
    env['ANTHROPIC_MODEL'] = model
    env['ANTHROPIC_DEFAULT_OPUS_MODEL'] = model
    env['ANTHROPIC_DEFAULT_SONNET_MODEL'] = model
    env['ANTHROPIC_DEFAULT_HAIKU_MODEL'] = model
    root['model'] = model
  }

  await fs.write(PATH, canonicalJson(root))
}

registerWriter('claude-code', configureClaudeCode)
