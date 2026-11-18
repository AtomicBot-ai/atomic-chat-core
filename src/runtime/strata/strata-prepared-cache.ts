import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { AtomicCoreError } from '../../contracts/index.js'
import type { StrataBackend } from '../../contracts/index.js'
import type { StrataPreparationStep } from './strata-prepare-plan.js'

export interface StrataCacheKey {
  modelId: string
  digest: string
  abi: 'strata-v1'
  backend: StrataBackend
}
interface Output {
  path: string
  size: number
  sha256: string
}
const backends = ['cuda', 'hip', 'metal', 'sycl'] as const
const ownerName = '.atomic-strata-owned.json',
  readyName = '.atomic-strata-ready.json'
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
function validKey(k: StrataCacheKey) {
  if (
    !k.modelId ||
    !/^[a-f0-9]{64}$/.test(k.digest) ||
    k.abi !== 'strata-v1' ||
    !backends.includes(k.backend)
  )
    throw new AtomicCoreError('INVALID_ARGUMENT', 'Invalid Strata cache identity.')
}
const marker = (k: StrataCacheKey) => ({
  version: 1,
  modelId: k.modelId,
  digest: k.digest,
  abi: k.abi,
  backend: k.backend,
})
const absent = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT'

/** Core-owned derivative receipts. Source metadata and path existence never imply readiness. */
export class StrataPreparedCache {
  private constructor(private readonly root: string) {}
  static async open(root: string): Promise<StrataPreparedCache> {
    await mkdir(root, { recursive: true, mode: 0o700 })
    const cache = await this.find(root)
    if (!cache) throw new AtomicCoreError('IO_ERROR', 'Strata prepared root disappeared.')
    return cache
  }

  static async find(root: string): Promise<StrataPreparedCache | null> {
    const info = await lstat(root).catch((error) => {
      if (absent(error)) return null
      throw error
    })
    if (!info) return null
    if (!info.isDirectory()) throw new AtomicCoreError('IO_ERROR', 'Strata prepared root is redirected.')
    return new StrataPreparedCache(await realpath(root))
  }
  path(k: StrataCacheKey): string {
    validKey(k)
    return join(this.root, sha(k.modelId), k.digest, k.abi, k.backend)
  }

  async stage(k: StrataCacheKey, operationId: string): Promise<string> {
    if (!/^[a-zA-Z0-9-]{1,128}$/.test(operationId))
      throw new AtomicCoreError('INVALID_ARGUMENT', 'Invalid Strata staging identity.')
    const dir = join(dirname(this.path(k)), `.${k.backend}-staging-${operationId}`)
    await mkdir(dirname(dir), { recursive: true, mode: 0o700 })
    let created = false
    try {
      await mkdir(dir, { mode: 0o700 })
      created = true
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
    await this.assertPath(dir)
    if (created) await this.json(join(dir, ownerName), marker(k))
    else if (!same(await this.readJson(join(dir, ownerName)), marker(k)))
      throw new AtomicCoreError('IO_ERROR', 'Refusing unowned Strata staging directory.')
    return dir
  }

  private async assertPath(path: string): Promise<void> {
    const rest = relative(this.root, path)
    if (!rest || rest.startsWith('..') || isAbsolute(rest) || (await realpath(path)) !== path)
      throw new AtomicCoreError('IO_ERROR', 'Strata derivative path is redirected or outside its owned root.')
  }

  private async file(dir: string, name: string): Promise<Output> {
    if (
      !name ||
      name.startsWith('.') ||
      name.includes('\\') ||
      name.split('/').some((s) => !s || s === '..' || s === '.') ||
      isAbsolute(name)
    )
      throw new AtomicCoreError('IO_ERROR', 'Invalid Strata derivative output path.')
    const path = join(dir, name)
    await this.assertPath(path)
    const f = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const before = await f.stat()
      if (!before.isFile()) throw new AtomicCoreError('IO_ERROR', 'Strata output is not a regular file.')
      const hash = createHash('sha256')
      for await (const chunk of f.createReadStream({ autoClose: false })) hash.update(chunk)
      const after = await f.stat()
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
        throw new AtomicCoreError('IO_ERROR', 'Strata output changed during verification.')
      return { path: name, size: before.size, sha256: hash.digest('hex') }
    } finally {
      await f.close()
    }
  }

  async recordStep(dir: string, step: StrataPreparationStep): Promise<void> {
    const outputs: Output[] = []
    for (const expected of step.outputs) {
      const actual = await this.file(dir, expected.path)
      if (
        (expected.size !== undefined && actual.size !== expected.size) ||
        (expected.sha256 !== undefined && actual.sha256 !== expected.sha256)
      )
        throw new AtomicCoreError(
          'MODEL_INCOMPATIBLE',
          'Strata converter output differs from the pinned recipe: ' + expected.path
        )
      outputs.push(actual)
    }
    await this.json(this.stepPath(dir, step.id), { version: 1, tool: step.tool, args: step.args, outputs })
  }

  async stepReady(dir: string, step: StrataPreparationStep): Promise<boolean> {
    try {
      const r = (await this.readJson(this.stepPath(dir, step.id))) as {
        version: number
        tool: string
        args: string[]
        outputs: Output[]
      }
      if (
        r.version !== 1 ||
        r.tool !== step.tool ||
        !same(r.args, step.args) ||
        !Array.isArray(r.outputs) ||
        r.outputs.length !== step.outputs.length
      )
        return false
      for (let i = 0; i < r.outputs.length; i++) {
        const recorded = r.outputs[i]!,
          expected = step.outputs[i]!
        if (
          recorded.path !== expected.path ||
          (expected.size !== undefined && recorded.size !== expected.size) ||
          (expected.sha256 !== undefined && recorded.sha256 !== expected.sha256) ||
          !same(await this.file(dir, recorded.path), recorded)
        )
          return false
      }
      return true
    } catch {
      return false
    }
  }

  private stepPath(dir: string, id: string): string {
    if (!/^[a-z0-9-]+$/.test(id))
      throw new AtomicCoreError('INVALID_ARGUMENT', 'Invalid Strata step identity.')
    return join(dir, '.atomic-strata-step-' + id + '.json')
  }

  private async inventory(dir: string, prefix = '', root = dir): Promise<Output[]> {
    await this.assertPath(dir)
    const outputs: Output[] = []
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      if (
        !prefix &&
        (entry.name === ownerName ||
          entry.name === readyName ||
          /^\.atomic-strata-step-[a-z0-9-]+\.json$/.test(entry.name))
      )
        continue
      const name = prefix ? prefix + '/' + entry.name : entry.name
      if (entry.isSymbolicLink())
        throw new AtomicCoreError('IO_ERROR', 'Strata derivative symlink is not allowed.')
      if (entry.isDirectory()) outputs.push(...(await this.inventory(join(dir, entry.name), name, root)))
      else outputs.push(await this.file(root, name))
    }
    return outputs
  }

  /** Record a verified prebuilt pack by source digest without copying its files. */
  async recordSourcePack(k: StrataCacheKey, staging: string): Promise<void> {
    if (
      dirname(staging) !== dirname(this.path(k)) ||
      !same(await this.readJson(join(staging, ownerName)), marker(k))
    ) {
      throw new AtomicCoreError('IO_ERROR', 'Strata staging identity does not match its source pack.')
    }
    await this.json(join(staging, 'source-pack.json'), { source_digest: k.digest })
  }

  async publish(k: StrataCacheKey, staging: string, checkSource?: () => Promise<void>): Promise<string> {
    const target = this.path(k)
    await this.assertPath(staging)
    if (
      dirname(staging) !== dirname(target) ||
      !same(await this.readJson(join(staging, ownerName)), marker(k))
    )
      throw new AtomicCoreError('IO_ERROR', 'Strata staging identity does not match its destination.')
    try {
      await lstat(target)
      throw new AtomicCoreError(
        'IO_ERROR',
        'Strata cache destination already exists; use maintenance to remove invalid owned data.'
      )
    } catch (e) {
      if (!absent(e)) throw e
    }
    const outputs = await this.inventory(staging)
    if (!outputs.length)
      throw new AtomicCoreError('MODEL_INCOMPATIBLE', 'Strata preparation produced no artifacts.')
    await checkSource?.()
    await this.json(join(staging, readyName), { ...marker(k), outputs })
    await rename(staging, target)
    return target
  }

  async ready(k: StrataCacheKey): Promise<string | null> {
    const dir = this.path(k)
    try {
      await this.assertPath(dir)
      if (!same(await this.readJson(join(dir, ownerName)), marker(k))) return null
      const r = (await this.readJson(join(dir, readyName))) as { outputs: Output[] }
      if (!same(r, { ...marker(k), outputs: r.outputs }) || !Array.isArray(r.outputs) || !r.outputs.length)
        return null
      return same(await this.inventory(dir), r.outputs) ? dir : null
    } catch {
      return null
    }
  }

  async publishedBytes(modelId: string): Promise<number> {
    const model = join(this.root, sha(modelId))
    const digests = await this.listDirs(model)
    let bytes = 0
    for (const digest of digests.filter((name) => /^[a-f0-9]{64}$/.test(name))) {
      for (const backend of backends) {
        const k = { modelId, digest, abi: 'strata-v1' as const, backend }
        const dir = this.path(k)
        try {
          if (!same(await this.readJson(join(dir, ownerName)), marker(k))) continue
          const r = (await this.readJson(join(dir, readyName))) as { outputs: Output[] }
          if (!same(r, { ...marker(k), outputs: r.outputs }) || !Array.isArray(r.outputs)) continue
          for (const output of r.outputs)
            if (Number.isSafeInteger(output.size) && output.size > 0) bytes += output.size
        } catch (error) {
          if (!absent(error)) throw error
        }
      }
    }
    return bytes
  }

  private async listDirs(dir: string): Promise<string[]> {
    try {
      await this.assertPath(dir)
      return (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name)
    } catch (error) {
      if (absent(error)) return []
      throw error
    }
  }

  async cleanup(modelId: string, keepDigest: string | null): Promise<void> {
    const model = join(this.root, sha(modelId))
    let digests
    try {
      await this.assertPath(model)
      digests = await readdir(model, { withFileTypes: true })
    } catch (e) {
      if (absent(e)) return
      throw e
    }
    for (const d of digests) {
      if (!d.isDirectory() || !/^[a-f0-9]{64}$/.test(d.name) || d.name === keepDigest) continue
      const abi = join(model, d.name, 'strata-v1')
      let entries
      try {
        await this.assertPath(abi)
        entries = await readdir(abi, { withFileTypes: true })
      } catch (e) {
        if (absent(e)) continue
        throw e
      }
      for (const e of entries) {
        if (!e.isDirectory()) continue
        const dir = join(abi, e.name)
        await this.assertPath(dir)
        let raw: unknown
        try {
          raw = await this.readJson(join(dir, ownerName))
        } catch {
          continue
        }
        const backend = (raw as { backend?: StrataBackend })?.backend
        if (
          !backend ||
          !backends.includes(backend) ||
          !same(raw, marker({ modelId, digest: d.name, abi: 'strata-v1', backend }))
        )
          continue
        await rm(dir, { recursive: true })
      }
    }
  }

  private async readJson(path: string): Promise<unknown> {
    await this.assertPath(path)
    const f = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const stat = await f.stat()
      if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error('Invalid Strata receipt')
      return JSON.parse(await f.readFile('utf8')) as unknown
    } finally {
      await f.close()
    }
  }
  private async json(path: string, value: unknown): Promise<void> {
    await this.assertPath(dirname(path))
    const tmp = path + '.' + randomUUID() + '.tmp'
    try {
      await writeFile(tmp, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 })
      await rename(tmp, path)
    } finally {
      await rm(tmp, { force: true })
    }
  }
}
