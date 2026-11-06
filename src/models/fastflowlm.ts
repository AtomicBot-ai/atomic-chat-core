import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { compareVersions } from '../backend/index.js'
import {
  buildFastFlowLmConfig,
  FLM_MODEL_INFO_PATH,
  FLM_MODEL_LIST_PATH,
  isFastFlowLmVariantId,
  parseFastFlowLmDescriptor,
} from '../client/index.js'
import type { DataLayout } from '../config/index.js'
import { AtomicCoreError, type ModelYmlFastFlowLm } from '../contracts/index.js'
import { parseModelYml } from './model-yml.js'

function invalid(reason: string): never {
  throw new AtomicCoreError('FASTFLOWLM_INVALID_INSTALLATION', reason)
}

/** Read the completion marker written last by the installer. Only the two generated control files are accepted. */
export function readFastFlowLmBlock(raw: unknown): ModelYmlFastFlowLm {
  let descriptor
  try {
    descriptor = parseFastFlowLmDescriptor(raw)
  } catch (error) {
    return invalid(String(error))
  }
  const block = raw as Record<string, unknown>
  if (
    block.schema_version !== 1 ||
    block.model_list_path !== FLM_MODEL_LIST_PATH ||
    block.model_info_path !== FLM_MODEL_INFO_PATH ||
    typeof block.catalog_digest !== 'string' ||
    !/^(?:sha256:)?[0-9a-f]{64}$/.test(block.catalog_digest)
  )
    return invalid('Invalid FastFlowLM completion marker or catalog digest.')
  return {
    ...descriptor,
    schema_version: 1,
    catalog_digest: block.catalog_digest,
    model_list_path: FLM_MODEL_LIST_PATH,
    model_info_path: FLM_MODEL_INFO_PATH,
  }
}

async function checkedPath(path: string) {
  if (relative(path, await realpath(path)) !== '') invalid('Redirected FastFlowLM path: ' + path)
  return path
}

/** Validate the opened regular file before reading its bytes (including named pipes and directories). */
async function smallFile(path: string) {
  const file = await openRegular(path)
  try {
    if ((await file.stat()).size > 16 * 1024 * 1024) invalid('Oversized FastFlowLM metadata: ' + path)
    return await file.readFile('utf8')
  } finally {
    await file.close()
  }
}

async function openRegular(path: string) {
  await checkedPath(path)
  const before = await lstat(path)
  if (!before.isFile()) invalid('Expected a regular file: ' + path)
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0))
  try {
    await checkedPath(path)
    const opened = await file.stat()
    if (!opened.isFile() || before.dev !== opened.dev || before.ino !== opened.ino)
      invalid('File replaced while checking: ' + path)
    return file
  } catch (e) {
    await file.close()
    throw e
  }
}

async function verifyFile(dir: string, expected: ModelYmlFastFlowLm['files'][number]) {
  const file = await openRegular(join(dir, expected.path))
  try {
    if ((await file.stat()).size !== expected.size) invalid('Wrong size: ' + expected.path)
    const digest = createHash('sha256')
    let config: string | undefined
    if (expected.path === 'config.json') {
      if (expected.size > 16 * 1024 * 1024) invalid('Oversized config.json.')
      const bytes = await file.readFile()
      digest.update(bytes)
      config = bytes.toString('utf8')
    } else {
      for await (const chunk of file.createReadStream({ autoClose: false })) digest.update(chunk)
    }
    if (digest.digest('hex') !== expected.sha256) invalid('Wrong SHA-256: ' + expected.path)
    return config
  } finally {
    await file.close()
  }
}

async function verifyInventory(dir: string, files: string[]) {
  const allowed = new Set(files)
  const directories = new Set(
    files.flatMap((file) => {
      const parts = file.split('/')
      return parts.slice(1).map((_, index) => parts.slice(0, index + 1).join('/'))
    })
  )
  async function visit(prefix: string) {
    const children = await readdir(await checkedPath(join(dir, prefix)), { withFileTypes: true })
    for (const entry of children) {
      const path = prefix ? prefix + '/' + entry.name : entry.name
      if (entry.isDirectory() && directories.has(path)) await visit(path)
      else if (!entry.isFile() || !allowed.has(path)) invalid('Unexpected installation entry: ' + path)
    }
  }
  await visit('')
}

function checkConfig(config: Record<string, unknown>, metadata: ModelYmlFastFlowLm, minimum: string) {
  // LM_Config resolves these optional weight paths relative to the model before starting the backend.
  for (const key of ['vision_model_weight', 'audio_model_weight']) {
    const path = config[key]
    if (path !== undefined && path !== '' && !metadata.files.some((file) => file.path === path))
      return invalid('Unlisted weight in config.json: ' + key)
  }
  const version = config.flm_version
  if (
    typeof version !== 'string' ||
    !/^\d+\.\d+\.\d+$/.test(version) ||
    !version.split('.').every((n) => Number(n) <= 0xffffffff) ||
    compareVersions(version, minimum) < 0
  )
    return invalid('Invalid or outdated config.json flm_version.')
  const text = config.text_config
  const context =
    text && typeof text === 'object' && 'max_position_embeddings' in text
      ? text.max_position_embeddings
      : config.max_position_embeddings
  if (
    context !== undefined &&
    (typeof context !== 'number' || !Number.isSafeInteger(context) || metadata.context_length > context)
  )
    return invalid('The declared context exceeds config.json.')
  return version.split('.').map(Number).join('.')
}

/** Read-only registry. Both lookup for launch and check use the same on-disk proof. */
export class FastFlowLmRegistry {
  readonly modelsDir: string
  constructor(private readonly layout: DataLayout) {
    this.modelsDir = layout.provider('fastflowlm').modelsDir
  }

  async get(id: string) {
    try {
      return await this.inspect(id)
    } catch (error) {
      if (error instanceof AtomicCoreError) throw error
      return invalid(error instanceof Error ? error.message : String(error))
    }
  }

  async forLoad(id: string) {
    if (isFastFlowLmVariantId(id)) {
      const path = join(await this.modelsRoot(), id)
      await lstat(path).catch((e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT')
          throw new AtomicCoreError('MODEL_NOT_FOUND', 'This FastFlowLM model is not installed.', id)
        throw e
      })
    }
    return this.get(id)
  }

  private async modelsRoot() {
    return join(await realpath(this.layout.root), relative(this.layout.root, this.modelsDir))
  }

  private async inspect(id: string) {
    if (!isFastFlowLmVariantId(id)) return invalid('Invalid installed FastFlowLM variant ID.')
    const root = await this.modelsRoot()
    const dir = await checkedPath(join(root, id))
    const yml = parseModelYml(await smallFile(join(dir, 'model.yml')))
    const metadata = readFastFlowLmBlock(yml.fastflowlm)
    const modelPath = yml.model_path
    if (
      [yml.mmproj_path, yml.mtp_draft_path, yml.dflash_draft_path].some((path) => path !== undefined) ||
      metadata.variant_id !== id ||
      modelPath.split(/[\\/]/).includes('..') ||
      (relative(resolve(this.layout.root, modelPath), join(this.modelsDir, id)) !== '' &&
        relative(resolve(this.layout.root, modelPath), dir) !== '')
    )
      return invalid('model.yml points to a different installation.')
    const { modelList, modelInfo } = buildFastFlowLmConfig(metadata)
    const listPath = join(dir, metadata.model_list_path),
      infoPath = join(dir, metadata.model_info_path)
    if (
      !isDeepStrictEqual(JSON.parse(await smallFile(listPath)), modelList) ||
      !isDeepStrictEqual(JSON.parse(await smallFile(infoPath)), modelInfo)
    )
      return invalid('Generated FLM configuration differs from the pinned plan.')
    await verifyInventory(dir, [
      'model.yml',
      metadata.model_list_path,
      metadata.model_info_path,
      ...metadata.files.map((file) => file.path),
    ])
    let config: string | undefined
    for (const file of metadata.files) {
      const content = await verifyFile(dir, file)
      if (content !== undefined) config = content
    }
    if (config === undefined) return invalid('Missing config.json.')
    const [family, variant] = metadata.checkpoint.split(':') as [string, string]
    const formatVersion = checkConfig(
      JSON.parse(config),
      metadata,
      modelList.models[family]![variant]!.flm_min_version
    )
    return {
      id,
      dir,
      yml: { ...yml, fastflowlm: metadata },
      formatVersion,
      env: { FLM_MODEL_PATH: root, FLM_CONFIG_PATH: listPath, FLM_MODELINFO_PATH: infoPath },
    }
  }

  async byPath(path: string) {
    if (!isAbsolute(path) || path.split(/[\\/]/).includes('..'))
      return invalid('Expected an absolute installation directory without traversal.')
    const id = basename(path)
    if (
      !isFastFlowLmVariantId(id) ||
      (relative(this.modelsDir, path) !== id && relative(await this.modelsRoot(), path) !== id)
    )
      return invalid('Expected a direct child of the FLM models directory.')
    return this.get(id)
  }

  async scan() {
    const entries: Awaited<ReturnType<FastFlowLmRegistry['get']>>[] = []
    const skipped: Array<{ dir: string; error: string }> = []
    const dirs = await (async () => {
      const root = await this.modelsRoot()
      return readdir(await checkedPath(root), { withFileTypes: true })
    })().catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    })
    for (const d of dirs.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!d.isDirectory()) continue
      try {
        entries.push(await this.get(d.name))
      } catch (error) {
        skipped.push({ dir: join(this.modelsDir, d.name), error: String(error) })
      }
    }
    return { entries, skipped }
  }
  async list() {
    return (await this.scan()).entries
  }
}
