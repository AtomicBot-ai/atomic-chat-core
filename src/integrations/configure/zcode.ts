/**
 * ZCode (github.com/zai-org/ZCode) is Z.ai's Electron desktop app. It ignores `OPENAI_BASE_URL` and
 * friends: the only source of custom providers is `<dataBase>/.zcode/v2/provider_config.json`,
 * shared by the desktop app, its web UI and its CLI, and polled once a second — so writing that file
 * is the whole integration, and a running ZCode picks the change up by itself. Port of
 * `configure_zcode` in the app's `core/system/commands.rs` (commit `ec1fd3ea7`).
 *
 * The file is validated with strict Zod schemas, and an invalid file is not rejected loudly: ZCode
 * treats it as empty, so every custom provider the user has silently disappears until it is fixed.
 * Hence the care below — patch only the entries we own, refuse rather than guess on anything
 * unexpected, and write under ZCode's own lock with a rename.
 */

import { mkdir, readdir, realpath, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AtomicCoreError } from '../../contracts/index.js'
import type { ConfigFs, JsonValue } from '../config-io.js'
import { canonicalJson } from '../config-io.js'
import { registerWriter } from './registry.js'

/** Provider id we own inside `provider_config.json`; personal ids may be anything but `account:*`. */
export const ZCODE_PROVIDER_ID = 'atomic-chat'
const ZCODE_PROVIDER_NAME = 'Atomic Chat'
/** ZCode only admits a provider whose API key is non-blank; the local server ignores it when auth is off. */
export const ZCODE_KEY_PLACEHOLDER = 'atomic'
/**
 * ZCode assumes 200K of context for any model it does not recognise — a wild over-claim for a local
 * model, which then never compacts and overflows mid-turn.
 */
export const ZCODE_CONTEXT_WINDOW = 65_536
const ZCODE_MAX_OUTPUT_TOKENS = 8_192
/**
 * ZCode's default request mapping sends `thinking`, `enable_thinking`, `reasoning_effort` and
 * `reasoning`, none of which llama-server reads. It does read `chat_template_kwargs`, and
 * `enable_thinking` is the switch the Qwen3 / GLM / DeepSeek templates expose.
 */
export const ZCODE_REASONING_MAP =
  '{"chat_template_kwargs": {"enable_thinking": reasoningLevel == "enabled"}}'
/** `max_completion_tokens` (ZCode's default) is OpenAI-only; `max_tokens` is what local backends read. */
const ZCODE_MAX_TOKENS_MAP = "{'max_tokens': maxOutputTokens}"
/** ZCode's own writers wait up to 8 s for the lock. */
export const ZCODE_LOCK_MAX_WAIT_MS = 8_000
/** A ZCode write holds the lock for milliseconds; one this old was left by a process that died. */
export const ZCODE_LOCK_STALE_AFTER_MS = 60_000
const LOCK_RETRY_DELAYS_MS = [25, 50, 100, 200, 400]

const refuse = (message: string, details?: string) => new AtomicCoreError('IO_ERROR', message, details)

type JsonObject = { [key: string]: JsonValue }

const isObject = (value: JsonValue | undefined): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * ZCode's `.zcode/v2` directory, resolved the way the desktop app does it: `dataBaseDir` from
 * `~/.zcode/v2/setting.json` (set when the user moves the data folder in ZCode), then
 * `$ZCODE_DATA_BASE_DIR`, then home. Absolute.
 */
export async function zcodeConfigDir(fs: ConfigFs, envBase: string | undefined): Promise<string> {
  let fromSetting: string | undefined
  const text = await fs.read('.zcode/v2/setting.json')
  if (text !== undefined) {
    try {
      const parsed = JSON.parse(text) as unknown
      const dir = isObject(parsed as JsonValue) ? (parsed as JsonObject)['dataBaseDir'] : undefined
      if (typeof dir === 'string' && dir.trim() !== '') fromSetting = dir.trim()
    } catch {
      // An unreadable setting.json is ZCode's to repair; its default location still applies.
    }
  }
  const fromEnv = envBase?.trim() ? envBase.trim() : undefined
  return join(fromSetting ?? fromEnv ?? fs.home, '.zcode', 'v2')
}

/** `parent[key]` as an array, created when absent; a value of another type is refused, never replaced. */
function arrayAt(parent: JsonObject, key: string, path: string): JsonValue[] {
  if (parent[key] === undefined) parent[key] = []
  const value = parent[key]
  if (!Array.isArray(value)) throw refuse(`${path} in provider_config.json is not an array`)
  return value
}

/** `parent[key]` as an object, created when absent. */
function objectAt(parent: JsonObject, key: string, path: string): JsonObject {
  if (parent[key] === undefined) parent[key] = {}
  const value = parent[key]
  if (!isObject(value)) throw refuse(`${path} in provider_config.json is not an object`)
  return value
}

const isOurs = (rule: JsonValue) => isObject(rule) && rule['providerId'] === ZCODE_PROVIDER_ID

/**
 * Apply Atomic Chat's provider, its model rule and the default selection to a parsed
 * `provider_config.json` (`undefined` when the file does not exist yet). Only entries whose
 * `providerId` is ours are replaced; every other provider, rule and key is carried over untouched.
 */
export function zcodePatchProviderConfig(
  existing: JsonValue | undefined,
  apiUrl: string,
  model: string,
  apiKey: string | undefined
): JsonValue {
  const modelId = model.trim()
  if (modelId === '')
    throw new AtomicCoreError('INVALID_ARGUMENT', 'ZCode needs a model: load one in a chat first.')
  const key = apiKey?.trim() ? apiKey.trim() : ZCODE_KEY_PLACEHOLDER

  const root = existing === undefined ? { schemaVersion: 1 } : structuredClone(existing)
  if (!isObject(root)) throw refuse('provider_config.json is not a JSON object')
  // ZCode refuses a file without a version, and one newer than it knows. We know exactly one shape.
  const version = root['schemaVersion']
  if (version === undefined || typeof version !== 'number' || !Number.isInteger(version) || version < 0)
    throw refuse(
      "ZCode's provider_config.json has no schemaVersion, so ZCode is ignoring it. Open Model Settings in ZCode to repair it, then try again."
    )
  if (version !== 1)
    throw refuse(
      `ZCode's provider_config.json uses schemaVersion ${version}, which this version of Atomic Chat does not know. Update Atomic Chat, or add the provider in ZCode's Model Settings.`
    )
  const config = objectAt(root, 'config', 'config')

  const provider: JsonObject = {
    providerId: ZCODE_PROVIDER_ID,
    providerName: ZCODE_PROVIDER_NAME,
    enabled: true,
    config: {
      group: 'standard-personal',
      access: { type: 'api-key', apiKey: key },
      api: { type: 'openai-chat-completions', baseUrl: apiUrl, headers: null },
      // Local servers expose no catalogue ZCode can discover: the provider lists the model Run was
      // pressed for.
      personalModelIds: [modelId],
      modelOrder: [modelId],
    },
  }
  const providerRules = arrayAt(
    objectAt(config, 'providerConfigRules', 'config.providerConfigRules'),
    'providerRules',
    'config.providerConfigRules.providerRules'
  )
  const existingAt = providerRules.findIndex(isOurs)
  if (existingAt >= 0) providerRules[existingAt] = provider
  else providerRules.push(provider)

  // `providerOrder` is optional and ZCode appends unlisted providers itself; only an existing list
  // needs us added — at the top, where Run expects us.
  if (config['providerOrder'] !== undefined) {
    const order = arrayAt(config, 'providerOrder', 'config.providerOrder')
    if (!order.includes(ZCODE_PROVIDER_ID)) order.unshift(ZCODE_PROVIDER_ID)
  }

  const modelRules = objectAt(config, 'modelConfigRules', 'config.modelConfigRules')
  // ZCode rejects the whole file when one provider/model pair has both a regular and a manual rule,
  // and its Advanced model settings write manual ones: drop ours from both lists first.
  const manual = arrayAt(
    modelRules,
    'manualProviderModelRules',
    'config.modelConfigRules.manualProviderModelRules'
  )
  modelRules['manualProviderModelRules'] = manual.filter((rule) => !isOurs(rule))
  const rules = arrayAt(modelRules, 'providerModelRules', 'config.modelConfigRules.providerModelRules')
  modelRules['providerModelRules'] = [
    ...rules.filter((rule) => !isOurs(rule)),
    {
      providerId: ZCODE_PROVIDER_ID,
      modelId,
      config: {
        properties: {
          contextWindow: ZCODE_CONTEXT_WINDOW,
          // An id matching one of ZCode's vision patterns would otherwise claim image input.
          inputFormat: { supportsImage: false },
        },
        optionSpecs: {
          maxOutputTokens: { max: ZCODE_MAX_OUTPUT_TOKENS, map: ZCODE_MAX_TOKENS_MAP },
          reasoningLevel: { values: ['disabled', 'enabled'], map: ZCODE_REASONING_MAP },
        },
      },
    },
  ]

  // A selection names a reasoning level the model allows; `enabled` is what ZCode itself picks.
  config['defaultModelSelection'] = {
    providerId: ZCODE_PROVIDER_ID,
    modelId,
    options: { reasoningLevel: 'enabled' },
  }
  return root
}

export interface ZcodeLockDeps {
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

const errnoCode = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code

/** Whether a lock directory was left behind, judged by its newest entry; a future time reads as new. */
async function lockIsStale(dir: string, staleAfterMs: number, now: number): Promise<boolean> {
  let newest = await stat(dir).then(
    (s) => s.mtimeMs,
    () => undefined
  )
  const names = await readdir(dir).catch(() => [] as string[])
  for (const name of names) {
    const mtime = await stat(join(dir, name)).then(
      (s) => s.mtimeMs,
      () => undefined
    )
    if (mtime !== undefined) newest = Math.max(newest ?? mtime, mtime)
  }
  return newest !== undefined && now - newest >= staleAfterMs
}

/** Remove an abandoned lock directory; whether it is gone. */
async function removeLock(dir: string): Promise<boolean> {
  for (const name of await readdir(dir).catch(() => [] as string[]))
    await rm(join(dir, name), { force: true }).catch(() => {})
  return rmdir(dir).then(
    () => true,
    () => false
  )
}

/**
 * ZCode's lock around a config file (`packages/shared/src/node/atomicFileLock.ts`): a `<file>.lock`
 * directory holding one `owner-<token>.json`. Taking it keeps a Run from interleaving with a save in
 * ZCode's own settings. Resolves with the release.
 */
export async function acquireZcodeLock(
  file: string,
  maxWaitMs: number,
  staleAfterMs: number,
  deps: ZcodeLockDeps = {}
): Promise<() => Promise<void>> {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const dir = `${file}.lock`
  const started = now()
  for (let attempt = 0; ;) {
    try {
      await mkdir(dir)
    } catch (error) {
      if (errnoCode(error) !== 'EEXIST')
        throw refuse(`Failed to lock ${file}`, error instanceof Error ? error.message : String(error))
      // A lock that cannot be removed falls through to the timeout instead of a tight loop.
      if ((await lockIsStale(dir, staleAfterMs, now())) && (await removeLock(dir))) continue
      if (now() - started >= maxWaitMs)
        throw refuse('ZCode is saving its model settings right now. Try again in a moment.')
      await sleep(LOCK_RETRY_DELAYS_MS[Math.min(attempt, LOCK_RETRY_DELAYS_MS.length - 1)] as number)
      attempt += 1
      continue
    }
    const createdAt = now()
    const token = `${process.pid}-${createdAt}-atomic-chat`
    const owner = join(dir, `owner-${token}.json`)
    const release = async () => {
      await rm(owner, { force: true }).catch(() => {})
      await rmdir(dir).catch(() => {})
    }
    try {
      await writeFile(owner, `${JSON.stringify({ pid: process.pid, createdAt, token })}\n`)
    } catch (error) {
      await release()
      throw refuse(`Failed to write ${owner}`, error instanceof Error ? error.message : String(error))
    }
    return release
  }
}

/** The filesystem half of the writer, on a resolved `.zcode/v2` directory. */
export async function configureZcodeIn(
  fs: ConfigFs,
  dir: string,
  apiUrl: string,
  model: string,
  apiKey: string | undefined,
  lockDeps: ZcodeLockDeps & { maxWaitMs?: number; staleAfterMs?: number } = {}
): Promise<void> {
  const path = join(dir, 'provider_config.json')
  // ZCode imports the providers of its pre-3.x `config.json` once, on the first start that finds no
  // `provider_config.json`. Creating that file first would skip the import for good.
  if (!(await fs.exists(path)) && (await fs.exists(join(dir, 'config.json'))))
    throw refuse('Open ZCode once so it can import your existing model providers, then click Run again.')

  await fs.mkdirp(dir)
  const release = await acquireZcodeLock(
    path,
    lockDeps.maxWaitMs ?? ZCODE_LOCK_MAX_WAIT_MS,
    lockDeps.staleAfterMs ?? ZCODE_LOCK_STALE_AFTER_MS,
    lockDeps
  )
  try {
    const text = (await fs.read(path)) ?? ''
    let existing: JsonValue | undefined
    if (text.trim() !== '') {
      try {
        existing = JSON.parse(text) as JsonValue
      } catch (error) {
        throw refuse(
          `Could not parse ${path}: ${error instanceof Error ? error.message : String(error)}. ZCode ignores the file while it is invalid, so fix or remove it and try again.`
        )
      }
    }
    const patched = zcodePatchProviderConfig(existing, apiUrl, model, apiKey)

    // A file ZCode cannot validate costs the user every custom provider, so keep the pre-Atomic
    // version once. It holds their API keys too, hence owner-only like the file itself.
    const backup = join(dir, 'provider_config.json.atomic-backup')
    if (text.trim() !== '' && !(await fs.exists(backup)))
      await fs.write(backup, text, { mode: 0o600 }).catch(() => {})

    // Renaming onto a symlink would replace it with a regular file and detach a managed dotfile.
    const target = await realpath(path).catch(() => path)
    await fs.write(target, canonicalJson(patched), { mode: 0o600 })
  } finally {
    await release()
  }
}

registerWriter('zcode', async (input) =>
  configureZcodeIn(
    input.fs,
    await zcodeConfigDir(input.fs, input.env['ZCODE_DATA_BASE_DIR']),
    input.apiUrl,
    input.model,
    input.apiKey
  )
)
