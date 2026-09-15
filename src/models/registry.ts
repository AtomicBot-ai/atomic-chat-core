/**
 * The installed-model registry: the depth-first scan of `<data>/llamacpp/models` that both the app's
 * extension (`list()`, index.ts:3438) and the Rust CLI (`list_chat_models_in`, cli/mod.rs:72) do, so
 * all three see the same ids for the same folder.
 *
 * Rules that are contract, not implementation detail: a directory holding `model.yml` *is* a model
 * and is never descended into; the id is its path relative to the models root with `\` rewritten to
 * `/`; ids sort ascending; an unreadable or invalid `model.yml` is skipped, not fatal — one broken
 * model must not hide the rest of the list.
 */

import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { AtomicCoreError } from '../contracts/index.js'
import type { LocalProviderId } from '../contracts/index.js'
import { MODEL_YML, modelDirFromId, modelIdFromDir, resolveDataRelative } from '../config/index.js'
import type { DataLayout } from '../config/index.js'
import { parseModelYml, serializeModelYml } from './model-yml.js'
import type { ModelYmlDocument, ModelYmlInput } from './model-yml.js'

export interface ModelEntry {
  id: string
  /** Directory holding `model.yml`. */
  dir: string
  yml: ModelYmlDocument
}

export interface ResolvedModelPaths {
  modelPath: string
  mmprojPath: string | undefined
}

/** Scan errors are collected rather than thrown: `models list` must still print the good entries. */
export interface ScanResult {
  entries: ModelEntry[]
  skipped: Array<{ dir: string; error: string }>
}

export class ModelRegistry {
  constructor(
    private readonly layout: DataLayout,
    private readonly provider: LocalProviderId = 'llamacpp-upstream'
  ) {}

  get modelsDir(): string {
    return this.layout.provider(this.provider).modelsDir
  }

  async scan(): Promise<ScanResult> {
    const root = this.modelsDir
    const result: ScanResult = { entries: [], skipped: [] }
    const stack: string[] = [root]
    while (stack.length) {
      const dir = stack.pop() as string
      const ymlPath = join(dir, MODEL_YML)
      const text = await readFile(ymlPath, 'utf8').catch(() => undefined)
      if (text !== undefined) {
        try {
          result.entries.push({ id: modelIdFromDir(root, dir), dir, yml: parseModelYml(text) })
        } catch (e) {
          result.skipped.push({ dir, error: (e as Error).message })
        }
        continue // a model directory is a leaf, whether or not it parsed
      }
      const children = await readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const child of children) if (child.isDirectory()) stack.push(join(dir, child.name))
    }
    result.entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    return result
  }

  async list(): Promise<ModelEntry[]> {
    return (await this.scan()).entries
  }

  /** What `models list` prints: embedding models cannot serve `/v1/chat/completions`. */
  async listChatModels(): Promise<ModelEntry[]> {
    return (await this.list()).filter((e) => e.yml.embedding !== true)
  }

  async find(id: string): Promise<ModelEntry | undefined> {
    const dir = modelDirFromId(this.modelsDir, id)
    const text = await readFile(join(dir, MODEL_YML), 'utf8').catch(() => undefined)
    if (text === undefined) return undefined
    return { id, dir, yml: parseModelYml(text) }
  }

  /** The CLI's wording, so a missing model reads the same from the core and from `jan-cli`. */
  async get(id: string): Promise<ModelEntry> {
    const entry = await this.find(id)
    if (!entry)
      throw new AtomicCoreError(
        'MODEL_NOT_FOUND',
        `Model '${id}' is not installed. Run \`atomic-chat-cli models list\` to see available models.`,
        join(modelDirFromId(this.modelsDir, id), MODEL_YML)
      )
    return entry
  }

  async read(id: string): Promise<ModelYmlDocument> {
    return (await this.get(id)).yml
  }

  /** Write `model.yml`, preserving unknown keys the caller carried over. */
  async write(id: string, doc: ModelYmlInput): Promise<void> {
    const dir = modelDirFromId(this.modelsDir, id)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, MODEL_YML), serializeModelYml(doc), 'utf8')
  }

  /** Remove the model directory. Refuses an id that escapes the models root. */
  async remove(id: string): Promise<void> {
    const dir = modelDirFromId(this.modelsDir, id)
    if (!isInside(this.modelsDir, dir))
      throw new AtomicCoreError('INVALID_ARGUMENT', `Refusing to delete outside the models folder`, dir)
    await rm(dir, { recursive: true, force: true })
  }

  /** Absolute GGUF and mmproj paths (`resolve_model_by_id_in`: absolute stays, relative joins `<data>`). */
  resolvePaths(yml: ModelYmlDocument): ResolvedModelPaths {
    const resolve = (p: string) => resolveDataRelative(this.layout.root, p, isAbsolute)
    return {
      modelPath: resolve(yml.model_path),
      mmprojPath: yml.mmproj_path ? resolve(yml.mmproj_path) : undefined,
    }
  }
}

/** `<root>/<something>`, never `<root>` itself and never an id that climbs out with `..`. */
function isInside(root: string, candidate: string): boolean {
  const rest = relative(root, candidate)
  return rest.length > 0 && !rest.startsWith('..') && !rest.split(sep).includes('..')
}
