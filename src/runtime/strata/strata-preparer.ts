import { copyFile, lstat, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { AtomicCoreError } from '../../contracts/index.js'
import type { StrataBackend, StrataPreparationOperation } from '../../contracts/index.js'
import type { StrataModelEntry, StrataRegistry } from '../../models/index.js'
import type { ManagedProcess } from '../shared/index.js'
import { strataPreparationPlan } from './strata-prepare-plan.js'
import { runStrataPreparationStep } from './strata-prepare-process.js'
import type { StrataConverterContext } from './strata-prepare-process.js'
import type { StrataPreparedCache } from './strata-prepared-cache.js'

export interface StrataPreparerDependencies {
  registry: Pick<StrataRegistry, 'get' | 'verify'>
  cache: StrataPreparedCache
  /** Verifies installed build/ABI/family/backend before returning its pinned converter context. */
  context(
    entry: StrataModelEntry,
    backend: StrataBackend
  ): Promise<Omit<StrataConverterContext, 'stagingDir'>>
  /** Reaps or rejects previous converter identities before any staging is opened for writes. */
  reconcile(modelId: string): Promise<void>
  onSpawn?: (operation: StrataPreparationOperation, process: ManagedProcess) => Promise<void>
  execute?: typeof runStrataPreparationStep
}

async function sourceStamp(entry: StrataModelEntry): Promise<string> {
  const root = await realpath(entry.dir),
    result = []
  for (const input of entry.strata.descriptor.files) {
    const path = join(root, input.path)
    if ((await realpath(path)) !== path)
      throw new AtomicCoreError('MODEL_INCOMPATIBLE', 'Strata source is redirected.')
    const stat = await lstat(path)
    if (!stat.isFile())
      throw new AtomicCoreError('MODEL_INCOMPATIBLE', 'Strata source is not a regular file.')
    result.push([input.path, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs])
  }
  return JSON.stringify(result)
}

/** Local-only recipes, resumable verified steps and publication after an unchanged-source check. */
export class StrataPreparer {
  constructor(private readonly deps: StrataPreparerDependencies) {}

  async run(
    op: StrataPreparationOperation,
    backend: StrataBackend,
    signal: AbortSignal,
    report: (stage: string, completed?: number, total?: number) => Promise<void>
  ): Promise<void> {
    signal.throwIfAborted()
    await this.deps.reconcile(op.model_id)
    const before = await this.deps.registry.get(op.model_id)
    const stamp = await sourceStamp(before)
    const entry = await this.deps.registry.verify(op.model_id, signal)
    if (
      entry.strata.source_digest !== op.source_digest ||
      before.strata.source_digest !== op.source_digest ||
      (await sourceStamp(entry)) !== stamp
    )
      throw new AtomicCoreError('MODEL_INCOMPATIBLE', 'Strata source changed before preparation.')
    const context = await this.deps.context(entry, backend)
    const key = {
      modelId: op.model_id,
      digest: op.source_digest,
      abi: entry.strata.descriptor.preparation_abi,
      backend,
    }
    if (await this.deps.cache.ready(key)) return
    const stagingDir = await this.deps.cache.stage(key, op.operation_id)
    const plan = strataPreparationPlan(entry.strata.descriptor, backend, entry.dir, stagingDir)
    const unchanged = async () => {
      signal.throwIfAborted()
      if (
        (await this.deps.registry.get(op.model_id)).strata.source_digest !== op.source_digest ||
        (await sourceStamp(entry)) !== stamp
      )
        throw new AtomicCoreError('MODEL_INCOMPATIBLE', 'Strata source changed during preparation.')
    }
    for (const step of plan.steps) {
      signal.throwIfAborted()
      if (await this.deps.cache.stepReady(stagingDir, step)) continue
      await report(step.id)
      await (this.deps.execute ?? runStrataPreparationStep)(
        { ...context, stagingDir },
        step,
        signal,
        this.deps.onSpawn ? (p) => this.deps.onSpawn!(op, p) : undefined
      )
      await unchanged()
      const profile = entry.strata.descriptor.inputs.expert_profile
      if (step.id === 'deepseek-pack' && profile) {
        await copyFile(join(entry.dir, profile), join(stagingDir, 'pack/expert-profile.bin'))
      }
      await this.deps.cache.recordStep(stagingDir, step)
    }
    await report('verifying')
    await unchanged()
    if (plan.readyPack) await this.deps.cache.recordSourcePack(key, stagingDir)
    // Converter scratch files are not part of the runtime pack and must not become ready artifacts.
    await rm(join(stagingDir, '.tmp'), { recursive: true, force: true })
    await this.deps.cache.publish(key, stagingDir, unchanged)
  }
}
