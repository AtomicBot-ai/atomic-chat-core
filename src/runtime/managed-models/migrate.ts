/**
 * Moving TensorRT-LLM's models into the managed model store (change `add-vllm-runtime`, design D5;
 * spec `managed-model-store`, "Модели TensorRT-LLM переезжают в общий корень"). Before the store, a
 * model of `tensorrt-llm` lived in `<data>/tensorrt-llm/models/<id>` (in the WSL guest,
 * `…/scopes/<key>/models/tensorrt-llm/<id>`); now every managed engine reads `managed-models/<id>`.
 *
 * Core does the move, at startup, before anything lists or loads a model: the layout is its own, and
 * it starts before the app lists anything. Each folder holding `model.yml` is renamed to the same id
 * under the store — one rename on one file system, so it is cheap and atomic per folder, and an engine
 * cache (`caches/<descriptor_id>/<model id>`) stays valid since the id does not change. A folder
 * without `model.yml` is a download still in progress and stays where it is: the client that started
 * it cleans it up. An id already in the store is a conflict: neither folder is touched, and the
 * conflict is reported (environment diagnostics). Empty folders left behind go, the old root with
 * them once nothing is in it. Every step is idempotent: on the next start there is nothing to move.
 *
 * What runs it is the core's own lock on its data folder (one owner per canonical data folder): the
 * old root and the store are both in that folder, or in that scope's guest folder.
 */
import { mkdir, readdir, readFile, rename, rmdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { MODEL_YML, modelIdFromDir } from '../../config/index.js'
import { AtomicCoreError } from '../../contracts/index.js'
import type { ManagedStoreMigration } from '../../contracts/index.js'
import type { WslDistributionTransport } from '../wsl/index.js'

/** The file operations a migration needs, on the host's file system or in the WSL guest. */
export interface StoreMigrationFs {
  /** Ids (`/`-separated, relative to `root`) of the folders under it that hold `model.yml`, sorted. */
  modelIds(root: string): Promise<string[]>
  exists(path: string): Promise<boolean>
  /** Renames `from` to `to` on the same file system, creating `to`'s parent first. */
  move(from: string, to: string): Promise<void>
  /** Removes every empty folder under `root`, and `root` itself once it is empty; never a file. */
  pruneEmpty(root: string): Promise<void>
  /** How a model path is joined: the host's separator, or `/` in the guest. */
  join(root: string, id: string): string
}

/** Moves every model folder of `from` into `to`; see the file banner. */
export async function migrateTensorrtLlmModels(options: {
  from: string
  to: string
  fs: StoreMigrationFs
}): Promise<ManagedStoreMigration> {
  const { from, to, fs } = options
  const result: ManagedStoreMigration = { from, to, moved: [], conflicts: [] }
  if (!(await fs.exists(from))) return result
  for (const id of await fs.modelIds(from)) {
    const source = fs.join(from, id)
    const target = fs.join(to, id)
    if (await fs.exists(target)) {
      result.conflicts.push({ model_id: id, source, target })
      continue
    }
    await fs.move(source, target)
    result.moved.push(id)
  }
  await fs.pruneEmpty(from)
  return result
}

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false
  )

/** The host's own file system: Linux (and the data folder of any platform). */
export const nodeStoreMigrationFs: StoreMigrationFs = {
  async modelIds(root) {
    const ids: string[] = []
    const stack = [root]
    while (stack.length > 0) {
      const dir = stack.pop() as string
      if (
        await readFile(join(dir, MODEL_YML)).then(
          () => true,
          () => false
        )
      ) {
        if (dir !== root) ids.push(modelIdFromDir(root, dir))
        continue // a model folder is a leaf
      }
      const children = await readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const child of children) if (child.isDirectory()) stack.push(join(dir, child.name))
    }
    return ids.sort()
  },
  exists,
  async move(from, to) {
    await mkdir(dirname(to), { recursive: true })
    await rename(from, to)
  },
  async pruneEmpty(root) {
    const prune = async (dir: string): Promise<boolean> => {
      const children = await readdir(dir, { withFileTypes: true }).catch(() => null)
      if (children === null) return false
      let empty = true
      for (const child of children) {
        if (!child.isDirectory() || !(await prune(join(dir, child.name)))) empty = false
      }
      if (!empty) return false
      return rmdir(dir).then(
        () => true,
        () => false
      )
    }
    await prune(root)
  },
  join: (root, id) => join(root, ...id.split('/')),
}

const GUEST_TIMEOUT_MS = 5 * 60_000

/**
 * The WSL guest's file system (Windows): every step a command in the guest, as root, as an argv —
 * never a shell — over the guest's own paths, so nothing crosses `\\wsl.localhost`.
 */
export function guestStoreMigrationFs(transport: WslDistributionTransport): StoreMigrationFs {
  const run = async (argv: string[]) => transport.exec(argv, { user: 'root', timeoutMs: GUEST_TIMEOUT_MS })
  return {
    async modelIds(root) {
      const answer = await run(['find', root, '-name', MODEL_YML, '-type', 'f', '-printf', '%h\n'])
      const dirs = answer.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith(`${root}/`))
        .sort()
      // A model folder is a leaf: a model.yml inside another model's folder is that model's file.
      const leaves = dirs.filter((dir) => !dirs.some((other) => other !== dir && dir.startsWith(`${other}/`)))
      return leaves.map((dir) => dir.slice(root.length + 1))
    },
    exists: async (path) => (await run(['test', '-e', path])).code === 0,
    async move(from, to) {
      const parent = to.slice(0, to.lastIndexOf('/'))
      await run(['mkdir', '-p', parent])
      const answer = await run(['mv', '-T', '--', from, to])
      if (answer.code !== 0) {
        throw new AtomicCoreError(
          'IO_ERROR',
          'A model could not be moved into the model store in the Atomic Chat distribution.',
          answer.stderr.trim()
        )
      }
    },
    async pruneEmpty(root) {
      await run(['find', root, '-depth', '-type', 'd', '-empty', '-delete'])
    },
    join: (root, id) => `${root}/${id}`,
  }
}
