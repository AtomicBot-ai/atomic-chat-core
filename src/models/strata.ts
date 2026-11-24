import { strataCudaProfile, strataProfileId } from '../client/strata-contracts.js'
import { parseStrataDescriptor } from '../client/index.js'
import { AtomicCoreError } from '../contracts/index.js'
import type { ModelYmlStrata } from '../contracts/index.js'

/** Acquisition metadata only. Readiness is a separate, core-owned preparation record. */
export function readStrataBlock(raw: unknown): ModelYmlStrata {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new AtomicCoreError('MODEL_INCOMPATIBLE', 'Invalid Strata model.yml block.')
  const v = raw as Record<string, unknown>
  if (
    v.schema_version !== 1 ||
    typeof v.source_digest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(v.source_digest) ||
    Object.keys(v).some((k) => !['schema_version', 'source_digest', 'descriptor'].includes(k))
  )
    throw new AtomicCoreError('MODEL_INCOMPATIBLE', 'Invalid Strata source digest or schema.')
  try {
    return {
      schema_version: 1,
      source_digest: v.source_digest,
      descriptor: parseStrataDescriptor(v.descriptor),
    }
  } catch (error) {
    throw new AtomicCoreError('MODEL_INCOMPATIBLE', String(error))
  }
}

import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { strataCanonicalDescriptor } from '../client/index.js'
import { modelDirFromId, type DataLayout } from '../config/index.js'
import { ModelRegistry } from './registry.js'
import { parseModelYml, type ModelYmlDocument } from './model-yml.js'
import type { FileHandle } from 'node:fs/promises'
import {
  estimateKvCache,
  ggufContextLength,
  readGgufMetadataChunked,
  type GgufMetadata,
} from './gguf/index.js'

/** The KV cost of a token of window by the GGUF estimate, as a spreadable field; `{}` when it cannot tell. */
export function strataKvBytesPerToken(metadata: Record<string, string>): { kvBytesPerToken?: number } {
  try {
    const perToken = estimateKvCache(metadata, undefined).per_token_size
    return perToken > 0 ? { kvBytesPerToken: perToken } : {}
  } catch {
    return {}
  }
}

export interface StrataModelEntry {
  id: string
  dir: string
  yml: ModelYmlDocument
  strata: ModelYmlStrata
}
const incompatible = (reason: string): never => {
  throw new AtomicCoreError('MODEL_INCOMPATIBLE', reason)
}
const architecture = { qwen38: 'qwen4exp', qwen36: 'qwen35moe', deepseek41: 'deepseek41' }

async function readHeader(handle: FileHandle): Promise<GgufMetadata> {
  return readGgufMetadataChunked(
    async (size) => {
      const bytes = Buffer.alloc(size)
      const { bytesRead } = await handle.read(bytes, 0, size, 0)
      return bytes.subarray(0, bytesRead)
    },
    { maxBytes: 64 * 1024 * 1024 }
  )
}

/** Acquisition is read-only here; only preparation can publish a separate readiness record. */
export class StrataRegistry {
  readonly modelsDir: string
  constructor(private readonly layout: DataLayout) {
    this.modelsDir = layout.provider('strata').modelsDir
  }

  private async checkedFile(path: string) {
    const expected = resolve(await realpath(this.layout.root), relative(this.layout.root, path))
    if ((await realpath(path)) !== expected) incompatible('Redirected Strata source path: ' + path)
    const before = await lstat(path)
    if (!before.isFile()) incompatible('Expected a regular Strata input: ' + path)
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0))
    try {
      const opened = await file.stat()
      if (
        !opened.isFile() ||
        before.ino !== opened.ino ||
        before.dev !== opened.dev ||
        (await realpath(path)) !== expected
      )
        incompatible('Strata input changed while opening: ' + path)
      return file
    } catch (error) {
      await file.close()
      throw error
    }
  }

  async get(id: string): Promise<StrataModelEntry> {
    try {
      const dir = modelDirFromId(this.modelsDir, id)
      const file = await this.checkedFile(join(dir, 'model.yml'))
      let yml
      try {
        if ((await file.stat()).size > 16 * 1024 * 1024) incompatible('Oversized Strata model.yml.')
        yml = parseModelYml(await file.readFile('utf8'))
      } finally {
        await file.close()
      }
      const strata = readStrataBlock(yml.strata)
      const digest = createHash('sha256').update(strataCanonicalDescriptor(strata.descriptor)).digest('hex')
      if (digest !== strata.source_digest) incompatible('Strata source digest differs from the descriptor.')
      const firstWeight = join(dir, strata.descriptor.inputs.weights[0]!)
      if (resolve(this.layout.root, yml.model_path) !== firstWeight)
        incompatible('Strata model_path must name the descriptor first shard.')
      return { id, dir, yml, strata }
    } catch (error) {
      if (error instanceof AtomicCoreError) throw error
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new AtomicCoreError('MODEL_NOT_FOUND', 'Strata model is not installed: ' + id)
      return incompatible(String(error))
    }
  }

  async list(): Promise<StrataModelEntry[]> {
    const entries: StrataModelEntry[] = []
    for (const entry of await new ModelRegistry(this.layout, 'strata').list()) {
      try {
        entries.push(await this.get(entry.id))
      } catch {
        /* One invalid acquisition never hides other models. */
      }
    }
    return entries
  }

  /** A bounded header read for the selector. Load independently verifies the same shard. */
  async contextLimit(id: string): Promise<number> {
    return (await this.contextFacts(id)).contextLimit
  }

  /**
   * The same bounded header read for the memory plan: the window limit and what a token of window
   * costs in KV cache by the GGUF estimate (`kvBytesPerToken` absent when the header cannot tell).
   */
  async contextFacts(id: string): Promise<{ contextLimit: number; kvBytesPerToken?: number }> {
    const entry = await this.get(id)
    const descriptor = entry.strata.descriptor
    const file = await this.checkedFile(join(entry.dir, descriptor.inputs.weights[0]!))
    try {
      const { metadata } = await readHeader(file)
      return {
        contextLimit: ggufContextLength(metadata) ?? descriptor.context_length,
        ...strataKvBytesPerToken(metadata),
      }
    } finally {
      await file.close()
    }
  }

  /** Hash every declared input, then compare the shard geometry using the same opened handles. */
  async verify(id: string, signal?: AbortSignal): Promise<StrataModelEntry & { contextLimit: number }> {
    const entry = await this.get(id)
    const descriptor = entry.strata.descriptor
    const externalEngram = strataCudaProfile(strataProfileId(descriptor))?.externalEngram
      ? descriptor.inputs.engram
      : undefined
    const headers = new Map<string, GgufMetadata>()
    try {
      for (const expected of descriptor.files) {
        signal?.throwIfAborted()
        const handle = await this.checkedFile(join(entry.dir, expected.path))
        try {
          const before = await handle.stat()
          if (before.size !== expected.size) incompatible('Wrong Strata input size: ' + expected.path)
          const hash = createHash('sha256')
          for await (const bytes of handle.createReadStream({ autoClose: false, start: 0 })) {
            signal?.throwIfAborted()
            hash.update(bytes)
          }
          if (hash.digest('hex') !== expected.sha256)
            incompatible('Wrong Strata input hash: ' + expected.path)
          if (expected.role === 'weights' || expected.path === externalEngram) {
            headers.set(expected.path, await readHeader(handle))
          }
          const after = await handle.stat()
          if (
            after.size !== before.size ||
            after.mtimeMs !== before.mtimeMs ||
            after.ctimeMs !== before.ctimeMs
          )
            incompatible('Strata input changed during verification: ' + expected.path)
        } finally {
          await handle.close()
        }
      }
      const shards = descriptor.inputs.weights.map((path) => headers.get(path)!)
      if (shards[0]!.metadata['general.architecture'] !== architecture[descriptor.family])
        incompatible('GGUF architecture differs from Strata family.')
      if (externalEngram) shards.push(headers.get(externalEngram)!)
      const tensors = String(shards.reduce((sum, shard) => sum + shard.tensor_count, 0))
      for (const [i, shard] of shards.entries()) {
        // Some split GGUFs put only metadata in their first shard.
        const minimumTensors = i === 0 && shards.length > 1 ? 0 : 1
        if (
          shard.version !== 3 ||
          !Number.isSafeInteger(shard.tensor_count) ||
          shard.tensor_count < minimumTensors
        )
          incompatible('Invalid Strata GGUF header.')
        if (
          shards.length > 1 &&
          (shard.metadata['split.no'] !== String(i) ||
            shard.metadata['split.count'] !== String(shards.length) ||
            shard.metadata['split.tensors.count'] !== tensors)
        )
          incompatible('Incomplete or inconsistent Strata shards.')
        if (shards.length === 1 && Number(shard.metadata['split.count'] ?? 1) !== 1)
          incompatible('Missing Strata shards.')
      }
      return { ...entry, contextLimit: ggufContextLength(shards[0]!.metadata) ?? descriptor.context_length }
    } catch (error) {
      signal?.throwIfAborted()
      if (error instanceof AtomicCoreError) throw error
      return incompatible(String(error))
    }
  }
}
