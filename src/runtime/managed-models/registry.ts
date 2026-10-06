/**
 * The managed model store's registry (spec `managed-model-store`, "Один корень моделей для всех
 * managed-движков"): a depth-first scan of the store's root, following the same rules
 * `src/models/registry.ts`'s `ModelRegistry` already uses for llama.cpp so all three surfaces (core,
 * the app, the CLI) see the same ids for the same folders — a directory holding `model.yml` *is* a
 * model and is never descended into, the id is its path relative to the root with `\` rewritten to
 * `/`, ids sort ascending, and an unreadable or invalid `model.yml` is skipped rather than failing the
 * whole scan (spec "Недокачанный каталог": a directory with files but no `model.yml` is not shown).
 * Every managed provider lists the same root under the same ids, whichever engine the model was
 * picked for: whether it runs on an engine is decided when it loads, never when it is listed.
 *
 * There is no caching here, by design: every call re-walks the directory, so a model the app finishes
 * downloading and writes `model.yml` for appears on the very next `list()` with no restart needed.
 * `parseManagedModelYml` (`model-dir.ts`) is the one parser both this scan and the single-id load-path
 * lookup (`readManagedModel`) share, so they can never disagree about what a `model.yml` means.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MODEL_YML, modelIdFromDir } from '../../config/index.js'
import { parseManagedModelYml } from './model-dir.js'
import type { ManagedModelYmlDocument } from './model-dir.js'

export interface ManagedModelEntry {
  id: string
  /** Directory holding `model.yml`. */
  dir: string
  yml: ManagedModelYmlDocument
}

/** Scan errors are collected rather than thrown: one broken model must not hide the rest of the list. */
export interface ManagedModelScanResult {
  entries: ManagedModelEntry[]
  skipped: Array<{ dir: string; error: string }>
}

export class ManagedModelRegistry {
  /**
   * The models root, or how to learn it at each scan (change `add-tensorrt-llm-windows`, task 2.8): on
   * Windows it is a folder in Atomic Chat's WSL distribution, known only once that exists — `null`
   * until then, which lists nothing.
   */
  constructor(private readonly modelsDir: string | (() => Promise<string | null>)) {}

  async scan(): Promise<ManagedModelScanResult> {
    const result: ManagedModelScanResult = { entries: [], skipped: [] }
    const root =
      typeof this.modelsDir === 'string' ? this.modelsDir : await this.modelsDir().catch(() => null)
    if (root === null) return result
    const stack: string[] = [root]
    while (stack.length) {
      const dir = stack.pop() as string
      const ymlPath = join(dir, MODEL_YML)
      const text = await readFile(ymlPath, 'utf8').catch(() => undefined)
      if (text !== undefined) {
        try {
          result.entries.push({
            id: modelIdFromDir(root, dir),
            dir,
            yml: parseManagedModelYml(text, ymlPath),
          })
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

  async list(): Promise<ManagedModelEntry[]> {
    return (await this.scan()).entries
  }
}
