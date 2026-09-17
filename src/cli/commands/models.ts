/** `models list` — the installed chat models, as a table or as JSON. */

import { parseArgs } from 'node:util'
import { LOCAL_PROVIDER } from '../../core/index.js'
import { ModelRegistry } from '../../models/index.js'
import type { ModelEntry } from '../../models/index.js'
import type { CliIo } from '../io.js'
import { formatBytes, layoutFor } from './shared.js'

/** `models list` reads the folder directly, exactly as the Rust CLI does — no core needed. */
export async function modelsCommand(argv: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { 'json': { type: 'boolean' }, 'data-folder': { type: 'string' } },
    allowPositionals: true,
    strict: true,
  })
  const sub = positionals[0] ?? 'list'
  if (sub !== 'list') {
    io.stderr(`Unknown models subcommand: ${sub}\n`)
    return 2
  }
  const registry = new ModelRegistry(layoutFor(values, io), LOCAL_PROVIDER)
  const models = await registry.listChatModels()
  if (values.json) {
    io.stdout(`${JSON.stringify(models.map(jsonModel), null, 2)}\n`)
    return 0
  }
  if (models.length === 0) {
    io.stderr('No chat models installed.\n\n')
    io.stderr('  Download one in the Atomic Chat desktop app, or serve a\n')
    io.stderr('  HuggingFace GGUF repo directly:\n\n')
    io.stderr('    atomic-chat-cli serve <owner>/<repo>\n')
    return 0
  }
  const width = Math.max(8, ...models.map((m) => m.id.length))
  io.stdout(`\n  ${'MODEL ID'.padEnd(width)}  ${'SIZE'.padStart(9)}  CAPABILITIES\n`)
  for (const model of models) {
    const size = model.yml.size_bytes ? formatBytes(model.yml.size_bytes) : '-'
    const caps = model.yml.capabilities?.length ? model.yml.capabilities.join(', ') : '-'
    io.stdout(`  ${model.id.padEnd(width)}  ${size.padStart(9)}  ${caps}\n`)
  }
  io.stdout('\n')
  return 0
}

function jsonModel(model: ModelEntry): Record<string, unknown> {
  return {
    id: model.id,
    name: model.yml.name ?? null,
    model_path: model.yml.model_path,
    size_bytes: model.yml.size_bytes ?? 0,
    capabilities: model.yml.capabilities ?? [],
    mmproj_path: model.yml.mmproj_path ?? null,
  }
}
