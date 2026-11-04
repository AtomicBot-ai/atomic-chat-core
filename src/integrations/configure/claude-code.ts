/**
 * Claude Code — `settings.json` in its config directory (`$CLAUDE_CONFIG_DIR`, else `~/.claude`).
 *
 * Port of `configure_claude_code` / `connect_claude_code` in the app (`src-tauri/src/core/system/
 * claude_config.rs`). Claude Code takes its endpoint from environment variables that its settings
 * file can carry, and that `env` wins over the shell's, so pointing it at a local model is an upsert
 * into that map plus the top-level `model` setting. Alongside the endpoint go empty values for the
 * Bedrock / Vertex / Foundry switches (Claude Code's documented way to unset a shell's), the tab
 * title off (it costs a side request to the model) and, when the served window is known, that window
 * and an output cap so Claude Code compacts before the server refuses. What every key held before is
 * kept in the sidecar `json-backup.ts` describes, for the app's Disconnect.
 *
 * Claude Code appends its own `/v1`, so `apiUrl` here is the bare `host:port` (the catalog marks
 * this agent `endpointWithPrefix: false`).
 *
 * An empty model means "nothing is loaded". `cli::integrations::configure` turns it into `None` for
 * this agent, and the writer then leaves every model key alone — it neither writes them nor removes
 * ones an earlier run left behind, so a rerun without a model keeps pointing at the last one.
 */

import { join } from 'node:path'
import { AtomicCoreError } from '../../contracts/index.js'
import { canonicalJson, keyOr, parseJsonStrict } from '../config-io.js'
import type { JsonValue } from '../config-io.js'
import {
  configDirFrom,
  getAt,
  isOurServerUrl,
  ourServerFromUrl,
  outputCap,
  readBackup,
  redo,
  writeBackup,
  writeConfigFile,
} from './json-backup.js'
import type { JsonPath, JsonWrite, OurServer } from './json-backup.js'
import { asJsonObject } from './json-tree.js'
import type { JsonObject } from './json-tree.js'
import type { ConfigureInput } from './registry.js'
import { registerWriter } from './registry.js'

const MODEL_KEYS = [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
] as const
/** Provider switches a shell can export that Claude Code would follow instead of our endpoint. */
const PROVIDER_SWITCHES = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
] as const

const env = (key: string): JsonPath => ['env', key]
const MODEL_PATHS: JsonPath[] = [...MODEL_KEYS.map(env), ['model']]

/** `settings.json` in `$CLAUDE_CONFIG_DIR` (absolute or `~`-relative), else `.claude/settings.json`. */
export function claudeSettingsPath(input: Pick<ConfigureInput, 'env' | 'fs'>): string {
  const dir = configDirFrom(input.env['CLAUDE_CONFIG_DIR'], input.fs.home)
  return dir === undefined ? '.claude/settings.json' : join(dir, 'settings.json')
}

function writesFor(input: ConfigureInput): JsonWrite[] {
  const { apiUrl, model, apiKey, contextLength } = input
  const writes: JsonWrite[] = [
    [env('ANTHROPIC_BASE_URL'), apiUrl],
    [env('ANTHROPIC_AUTH_TOKEN'), keyOr(apiKey, 'atomic')],
  ]
  for (const name of PROVIDER_SWITCHES) writes.push([env(name), ''])
  writes.push([env('CLAUDE_CODE_DISABLE_TERMINAL_TITLE'), '1'])
  if (contextLength !== undefined && contextLength > 0) {
    writes.push([env('CLAUDE_CODE_MAX_CONTEXT_TOKENS'), String(contextLength)])
    writes.push([env('CLAUDE_CODE_MAX_OUTPUT_TOKENS'), String(outputCap(contextLength))])
  }
  if (model !== '') {
    // ANTHROPIC_MODEL overrides the `model` setting; the tier aliases make every Opus/Sonnet/Haiku
    // request route to the single local model too.
    for (const key of MODEL_KEYS) writes.push([env(key), model])
    writes.push([['model'], model])
  }
  return writes
}

/** Settings an earlier release wrote without a backup: the endpoint is this server. */
function forgetLegacy(root: JsonObject, server: OurServer | undefined): void {
  const base = getAt(root, env('ANTHROPIC_BASE_URL'))
  if (typeof base !== 'string' || !isOurServerUrl(server, base)) return
  const envObject = asJsonObject(root['env'])!
  const model: JsonValue | undefined = envObject['ANTHROPIC_MODEL']
  for (const key of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', ...MODEL_KEYS]) delete envObject[key]
  if (model !== undefined && root['model'] === model) delete root['model']
}

export async function configureClaudeCode(input: ConfigureInput): Promise<void> {
  const { fs, apiUrl } = input
  const path = claudeSettingsPath(input)

  const text = await fs.read(path)
  const parsed = text === undefined ? {} : parseJsonStrict(text, fs.absolute(path))
  const root = asJsonObject(parsed)
  if (!root) throw new AtomicCoreError('IO_ERROR', 'settings.json is not a JSON object')

  const server = ourServerFromUrl(apiUrl)
  const backup = redo(
    root,
    await readBackup(fs, path),
    text !== undefined,
    writesFor(input),
    MODEL_PATHS,
    (r) => forgetLegacy(r, server)
  )
  // Sidecar first: a crash between the two leaves a backup whose values simply do not match yet.
  await writeBackup(fs, path, backup)
  await writeConfigFile(fs, path, canonicalJson(root))
}

registerWriter('claude-code', configureClaudeCode)
