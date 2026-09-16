/**
 * Atomic Agent keeps its user config in `<state dir>/config.json` (default `~/.atomic-agent`,
 * overridable with `ATOMIC_AGENT_STATE_DIR`). The file is the agent's own trust surface, so the
 * write is a merge: other providers, keys and blocks survive, and `version` is deliberately not
 * stamped — the agent fills it, and every missing block, with its own defaults on the next start.
 *
 * Two rules are easy to get subtly wrong:
 *
 *  - A brand-new `llm.providers` list needs the agent's OWN default `local-llama` entry alongside
 *    ours, because the agent refuses to load a file whose `activeEmbeddingProvider` names a provider
 *    that is not in the list. That entry's `url` (chat) is mode-aware, and its `baseUrl` (embeddings)
 *    mirrors where the agent would have looked with no `llm` block at all — otherwise creating the
 *    block silently repoints embeddings at the chat daemon.
 *  - `activeEmbeddingProvider` is repaired only when it is missing or dangling, and always to
 *    `local-llama`. Repairing it to US would quietly hand memory recall to Atomic Chat, which is not
 *    what Run asked for.
 */

import { AtomicCoreError } from '../../contracts/index.js'
import type { JsonValue } from '../config-io.js'
import { canonicalJson, parseJsonStrict } from '../config-io.js'
import type { JsonObject } from './json-tree.js'
import { asJsonArray, asJsonObject } from './json-tree.js'
import type { ConfigureWriter } from './registry.js'
import { registerWriter } from './registry.js'

const PROVIDER_ID = 'atomic-chat'
/** The agent's own llama.cpp entry; the repair target for a dangling embedding selection. */
const LOCAL_PROVIDER_ID = 'local-llama'
const DEFAULT_LLAMA_URL = 'http://127.0.0.1:8080'
const DEFAULT_MANAGED_PORT = 19_091
const DEFAULT_EMBEDDINGS_PORT = 19_092
const REQUEST_TIMEOUT_MS = 300_000

function numberAt(value: JsonValue | undefined, key: string): number | undefined {
  const found = asJsonObject(value)?.[key]
  return typeof found === 'number' ? found : undefined
}

function stringAt(value: JsonValue | undefined, key: string): string | undefined {
  const found = asJsonObject(value)?.[key]
  return typeof found === 'string' && found.length > 0 ? found : undefined
}

/**
 * Where the agent would look for embeddings if we were not writing an `llm` block at all: the
 * no-block branch of its embedding-provider registry, which reads
 * `embeddings.enabled ? embeddings.url : localModels.url`. `chatUrl` is the mode-aware URL already
 * computed for this entry, because `localModels.url` is itself resolved to the managed daemon before
 * that branch sees it.
 */
export function atomicAgentEmbeddingBaseUrl(root: JsonObject, chatUrl: string): string {
  const embeddings = asJsonObject(root['localModels'])?.['embeddings']
  if (asJsonObject(embeddings)?.['enabled'] !== true) return chatUrl
  const explicit = stringAt(embeddings, 'url')
  if (explicit) return explicit
  return `http://127.0.0.1:${numberAt(embeddings, 'port') ?? DEFAULT_EMBEDDINGS_PORT}`
}

/** The `llama-server` entry Atomic Agent would synthesise for itself, from the same inputs. */
export function atomicAgentLocalLlamaEntry(root: JsonObject): JsonObject {
  const localModels = asJsonObject(root['localModels'])
  // Under `mode: "managed"` the agent ignores `localModels.url` and talks to the daemon it runs.
  const url =
    localModels?.['mode'] === 'managed'
      ? `http://127.0.0.1:${numberAt(localModels['managed'], 'port') ?? DEFAULT_MANAGED_PORT}`
      : (stringAt(root['localModels'], 'url') ?? DEFAULT_LLAMA_URL)
  return {
    id: LOCAL_PROVIDER_ID,
    kind: 'llama-server',
    baseUrl: atomicAgentEmbeddingBaseUrl(root, url),
    url,
  }
}

function lists(providers: JsonValue[], id: string): boolean {
  return providers.some((p) => asJsonObject(p)?.['id'] === id)
}

/** The whole merge, with no I/O, so the rules above are testable without a state directory. */
export function atomicAgentPatchConfig(
  parsed: JsonValue,
  apiUrl: string,
  model: string,
  apiKey: string
): JsonObject {
  // The agent's `parseOptionalString` rejects `""` outright rather than treating it as absent, so an
  // empty model would take the whole file down at its next start. Fail before touching anything.
  if (model.trim() === '') {
    throw new AtomicCoreError('INVALID_ARGUMENT', 'Atomic Agent needs a model: none is running.')
  }
  const root = asJsonObject(parsed)
  if (!root) throw new AtomicCoreError('IO_ERROR', 'config.json is not a JSON object')

  // Read before the `llm` block is rewritten: it is derived from `localModels`, never written back.
  const localLlama = atomicAgentLocalLlamaEntry(root)

  if (asJsonObject(root['llm']) === undefined) root['llm'] = {}
  const llm = asJsonObject(root['llm']) as JsonObject

  const currentEmbedding =
    typeof llm['activeEmbeddingProvider'] === 'string' ? llm['activeEmbeddingProvider'] : undefined

  const providers = asJsonArray(llm['providers']) ?? []
  llm['providers'] = providers
  if (providers.length === 0) providers.push({ ...localLlama })

  const existing = providers.findIndex((p) => asJsonObject(p)?.['id'] === PROVIDER_ID)
  // A timeout the user tuned on our entry is theirs; we only fill the gap.
  const timeout =
    existing >= 0
      ? (numberAt(providers[existing], 'requestTimeoutMs') ?? REQUEST_TIMEOUT_MS)
      : REQUEST_TIMEOUT_MS
  const entry: JsonObject = {
    id: PROVIDER_ID,
    kind: 'openai-compatible',
    baseUrl: apiUrl,
    // Stored as an `openai-compatible` provider, and most such clients reject an empty key.
    apiKey: apiKey.trim() === '' ? 'atomic' : apiKey.trim(),
    defaultChatModel: model.trim(),
    supportsTools: true,
    requestTimeoutMs: timeout,
  }
  if (existing >= 0) providers[existing] = entry
  else providers.push(entry)

  // Embeddings drive memory recall, not chat, so a working selection is left alone.
  const repair = currentEmbedding === undefined || !lists(providers, currentEmbedding)
  if (repair && !lists(providers, LOCAL_PROVIDER_ID)) providers.push(localLlama)

  // Pressing Run is an explicit "use this", so the text provider is switched outright.
  llm['activeTextProvider'] = PROVIDER_ID
  if (repair) llm['activeEmbeddingProvider'] = LOCAL_PROVIDER_ID

  return root
}

export const configureAtomicAgent: ConfigureWriter = async ({ apiUrl, model, apiKey, fs, env }) => {
  const override = env['ATOMIC_AGENT_STATE_DIR']?.trim()
  const path = `${override && override !== '' ? override : '.atomic-agent'}/config.json`
  const text = await fs.read(path)
  const parsed = text === undefined ? {} : parseJsonStrict(text, fs.absolute(path))
  await fs.write(path, canonicalJson(atomicAgentPatchConfig(parsed, apiUrl, model, apiKey)))
}

registerWriter('atomic-agent', configureAtomicAgent)
