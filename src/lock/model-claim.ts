/** Atomic cross-process ownership claim for a model shared by the app and the core. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AtomicCoreError } from '../contracts/index.js'
import type { DataLayout } from '../config/index.js'
import { isProcessAlive, processStartEpoch } from './process-identity.js'

export interface ModelClaim {
  claim_id: string
  provider: string
  model_id: string
  owner_kind: 'core' | 'app'
  owner_pid: number
  owner_started_at: string | null
  owner_instance_id: string
  state: 'loading' | 'ready'
  updated_at: string
}

export interface ModelClaimHandle {
  claim: ModelClaim
  path: string
  update(state: ModelClaim['state']): Promise<void>
  release(): Promise<void>
}

export function modelClaimKey(provider: string, modelId: string): string {
  return createHash('sha256').update(provider).update('\0').update(modelId).digest('hex')
}

export async function acquireModelClaim(
  layout: DataLayout,
  provider: string,
  modelId: string,
  ownerInstanceId: string
): Promise<ModelClaimHandle> {
  await mkdir(layout.core.modelClaims, { recursive: true })
  const path = join(layout.core.modelClaims, modelClaimKey(provider, modelId))
  const claim: ModelClaim = {
    claim_id: randomUUID(),
    provider,
    model_id: modelId,
    owner_kind: 'core',
    owner_pid: process.pid,
    owner_started_at: (await processStartEpoch(process.pid)) ?? null,
    owner_instance_id: ownerInstanceId,
    state: 'loading',
    updated_at: new Date().toISOString(),
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await mkdir(path)
      await writeClaim(path, claim)
      return handle(path, claim)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      const existing = await readClaim(path)
      if (existing?.owner_kind === 'core' && existing.owner_instance_id === ownerInstanceId)
        return handle(path, existing)
      if (!existing || !(await claimOwnerIsStale(existing))) {
        throw new AtomicCoreError(
          'CORE_ALREADY_RUNNING',
          `Another runtime already owns "${modelId}".`,
          existing ? `${existing.owner_kind} pid ${existing.owner_pid} (${existing.state})` : path
        )
      }
      const stale = `${path}.stale-${randomUUID()}`
      await rename(path, stale).catch(() => undefined)
      await rm(stale, { recursive: true, force: true }).catch(() => undefined)
    }
  }
  throw new AtomicCoreError('CORE_ALREADY_RUNNING', `Could not claim "${modelId}".`)
}

async function claimOwnerIsStale(claim: ModelClaim): Promise<boolean> {
  if (!isProcessAlive(claim.owner_pid)) return true
  if (!claim.owner_started_at) return false
  const actual = await processStartEpoch(claim.owner_pid)
  return actual !== undefined && actual !== claim.owner_started_at
}

async function readClaim(path: string): Promise<ModelClaim | undefined> {
  try {
    return JSON.parse(await readFile(join(path, 'claim.json'), 'utf8')) as ModelClaim
  } catch {
    return undefined
  }
}

async function writeClaim(path: string, claim: ModelClaim): Promise<void> {
  const target = join(path, 'claim.json')
  const temp = join(path, `claim.${claim.claim_id}.${randomUUID()}.tmp`)
  await writeFile(temp, `${JSON.stringify(claim, null, 2)}\n`)
  await rename(temp, target)
}

function handle(path: string, claim: ModelClaim): ModelClaimHandle {
  return {
    claim,
    path,
    async update(state) {
      claim.state = state
      claim.updated_at = new Date().toISOString()
      await writeClaim(path, claim)
    },
    async release() {
      const current = await readClaim(path)
      if (current?.claim_id === claim.claim_id) await rm(path, { recursive: true, force: true })
    },
  }
}
