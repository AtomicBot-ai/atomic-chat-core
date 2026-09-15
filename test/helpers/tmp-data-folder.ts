/**
 * A throwaway `<data>` folder with the app's real layout (PLAN.md §8.1), so tests exercise the same
 * paths the desktop app writes: `<data>/llamacpp/models/<id>/model.yml`, backend packs under
 * `<data>/<provider>/backends/<version>/<backend>/build/bin/`, and `<data>/atomic-core/`.
 */
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { dataLayout, llamaServerExeName, modelDirFromId } from '../../src/config/index.js'
import type { DataLayout } from '../../src/config/index.js'
import { serializeModelYml } from '../../src/models/index.js'
import type { ModelYmlInput } from '../../src/models/index.js'
import type { LocalProviderId } from '../../src/contracts/index.js'

export interface TmpDataFolder {
  root: string
  layout: DataLayout
  /** Write `model.yml` plus a placeholder GGUF; returns the model directory. */
  writeModel: (
    id: string,
    yml?: Partial<ModelYmlInput>,
    opts?: { ggufBytes?: Buffer | number; provider?: LocalProviderId }
  ) => Promise<string>
  /** Create a backend pack whose `llama-server` is `script`; returns the executable path. */
  writeBackend: (
    provider: LocalProviderId,
    version: string,
    backend: string,
    script?: string
  ) => Promise<string>
  cleanup: () => Promise<void>
}

export async function makeTmpDataFolder(prefix = 'atomic-core-data-'): Promise<TmpDataFolder> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  const layout = dataLayout(root)
  await mkdir(layout.core.dir, { recursive: true })

  const writeModel: TmpDataFolder['writeModel'] = async (id, yml = {}, opts = {}) => {
    const provider = opts.provider ?? 'llamacpp-upstream'
    const modelsDir = layout.provider(provider).modelsDir
    const dir = modelDirFromId(modelsDir, id)
    await mkdir(dir, { recursive: true })
    const relativeModelPath = yml.model_path ?? `llamacpp/models/${id}/model.gguf`
    const gguf = opts.ggufBytes ?? 32
    const bytes = Buffer.isBuffer(gguf) ? gguf : Buffer.alloc(gguf, 0x47)
    const ggufPath = join(root, ...relativeModelPath.split('/'))
    await mkdir(dirname(ggufPath), { recursive: true })
    await writeFile(ggufPath, bytes)
    const doc: ModelYmlInput = {
      model_path: relativeModelPath,
      name: id.split('/').pop() ?? id,
      size_bytes: bytes.length,
      model_size_bytes: bytes.length,
      ...yml,
    }
    await writeFile(join(dir, 'model.yml'), serializeModelYml(doc), 'utf8')
    return dir
  }

  const writeBackend: TmpDataFolder['writeBackend'] = async (provider, version, backend, script) => {
    const dir = join(layout.provider(provider).backendsDir, version, backend, 'build', 'bin')
    await mkdir(dir, { recursive: true })
    const exe = join(dir, llamaServerExeName(process.platform))
    const body = script ?? '#!/bin/sh\nexit 0\n'
    await writeFile(exe, body)
    await chmod(exe, 0o755).catch(() => {})
    return exe
  }

  return {
    root,
    layout,
    writeModel,
    writeBackend,
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}
