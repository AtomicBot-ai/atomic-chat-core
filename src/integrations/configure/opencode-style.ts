/**
 * The provider block three agents share: OpenCode, its fork MiMo Code, and Kilo Code.
 *
 * All three keep one JSON file whose `provider.<id>` map names an `@ai-sdk/openai-compatible`
 * endpoint, and all three are configured by upserting a single `atomic` entry into it and then
 * selecting `"<providerId>/<modelId>"` as the active model. The Rust side has this logic written
 * out three times (`configure_opencode`, `configure_mimo`, `configure_kilo`); only four things
 * differ, so here it is once with those four as parameters.
 *
 * Everything the user already had is preserved: other providers, unrelated top-level keys, and an
 * existing `$schema`. The active model is overwritten on purpose — pressing Run is an explicit
 * "use this one".
 */

import { AtomicCoreError } from '../../contracts/index.js'
import { canonicalJson, keyOr, parseJsonLenient, parseJsonStrict } from '../config-io.js'
import { asJsonObject } from './json-tree.js'
import type { ConfigureInput } from './registry.js'

export interface OpencodeStyleSpec {
  /** Config directory relative to the home, e.g. `.config/opencode`. */
  dir: string
  /** File name inside `dir`. Doubles as the name used in the "not a JSON object" error. */
  file: string
  /** `$schema` seeded into a config that does not carry one yet. */
  schema: string
  /** `.jsonc` files are read with the json5 tolerance; strict JSON files are not. */
  lenient: boolean
}

export async function writeOpencodeStyleConfig(
  input: ConfigureInput,
  spec: OpencodeStyleSpec
): Promise<void> {
  const { fs, apiUrl, model, apiKey } = input
  const path = `${spec.dir}/${spec.file}`
  // The directory is created before the file is read, so a parse failure below still leaves it —
  // matching `create_dir_all` sitting above the read in the Rust writers.
  await fs.mkdirp(spec.dir)

  const text = await fs.read(path)
  const parse = spec.lenient ? parseJsonLenient : parseJsonStrict
  const parsed = text === undefined ? {} : parse(text, fs.absolute(path))
  const root = asJsonObject(parsed)
  if (!root) throw new AtomicCoreError('IO_ERROR', `${spec.file} is not a JSON object`)

  // `entry(..).or_insert_with(..)`: an existing `$schema` wins, even an explicit `null`.
  if (!('$schema' in root)) root['$schema'] = spec.schema

  const provider = asJsonObject(root['provider']) ?? {}
  root['provider'] = provider
  provider['atomic'] = {
    name: 'Atomic Chat',
    npm: '@ai-sdk/openai-compatible',
    options: { baseURL: apiUrl, apiKey: keyOr(apiKey, 'atomic') },
    models: { [model]: { name: model } },
  }
  root['model'] = `atomic/${model}`

  await fs.write(path, canonicalJson(root))
}
