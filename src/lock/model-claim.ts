/** Atomic cross-process ownership claim for a model shared by the app and the core. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
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

const isEexist = (e: unknown) => (e as NodeJS.ErrnoException).code === 'EEXIST'
const isEnoent = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT'

/** Every filesystem failure leaves the core as a coded error, keeping the errno as its cause. */
function claimIoError(action: string, path: string, cause: unknown): AtomicCoreError {
  return new AtomicCoreError(
    'IO_ERROR',
    `Cannot ${action} the model claim at ${path}`,
    (cause as Error).message,
    { cause }
  )
}

function alreadyClaimed(modelId: string, path: string, owner?: ModelClaim): AtomicCoreError {
  return new AtomicCoreError(
    'CORE_ALREADY_RUNNING',
    `Another runtime already owns "${modelId}".`,
    owner ? `${owner.owner_kind} pid ${owner.owner_pid} (${owner.state})` : path
  )
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
  await mkdir(layout.core.modelClaims, { recursive: true }).catch((cause: unknown) => {
    throw claimIoError('create the claims folder for', layout.core.modelClaims, cause)
  })
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
      // A claim directory owned by someone else is the only expected `EEXIST`; anything else (a file
      // where the folder belongs, a full volume) is a filesystem failure, not claim contention.
      await mkdir(path).catch((cause: unknown) => {
        if (isEexist(cause)) throw cause
        throw claimIoError('create', path, cause)
      })
      await writeClaim(path, claim).catch((cause: unknown) => {
        throw claimIoError('write', join(path, 'claim.json'), cause)
      })
      return handle(path, claim)
    } catch (e) {
      if (!isEexist(e)) throw e
      const existing = await readClaim(path)
      if (existing?.owner_kind === 'core' && existing.owner_instance_id === ownerInstanceId)
        return handle(path, existing)
      if (!existing || !(await claimOwnerIsStale(existing))) {
        throw alreadyClaimed(modelId, path, existing)
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

async function writeClaim(path: string, claim: ModelClaim, updating = false): Promise<void> {
  const target = join(path, 'claim.json')
  const temp = join(path, `claim.${claim.claim_id}.${randomUUID()}.tmp`)
  try {
    await writeFile(temp, `${JSON.stringify(claim, null, 2)}\n`)
    if (updating) {
      // Check after staging. If the directory is replaced after this check, the unique temp file
      // disappears with it and rename cannot overwrite the replacement owner's record.
      const owner = await readClaim(path)
      if (owner?.claim_id !== claim.claim_id) {
        if (!owner) await stat(path)
        throw alreadyClaimed(claim.model_id, path, owner)
      }
    }
    await rename(temp, target)
  } catch (cause) {
    await rm(temp, { force: true }).catch(() => {})
    throw cause
  }
}

async function updateClaim(path: string, claim: ModelClaim): Promise<void> {
  const target = join(path, 'claim.json')
  try {
    await writeClaim(path, claim, true)
    return
  } catch (cause) {
    if (cause instanceof AtomicCoreError) throw cause
    if (!isEnoent(cause)) throw claimIoError('write', target, cause)
  }
  // Only the winner of the same exclusive mkdir used by acquire can restore a missing claim.
  await mkdir(dirname(path), { recursive: true }).catch((cause: unknown) => {
    throw claimIoError('create the claims folder for', path, cause)
  })
  await mkdir(path).catch(async (cause: unknown) => {
    if (isEexist(cause)) throw alreadyClaimed(claim.model_id, path, await readClaim(path))
    throw claimIoError('create', path, cause)
  })
  await writeClaim(path, claim).catch((cause: unknown) => {
    throw claimIoError('write', target, cause)
  })
}

function handle(path: string, claim: ModelClaim): ModelClaimHandle {
  return {
    claim,
    path,
    async update(state) {
      const next = { ...claim, state, updated_at: new Date().toISOString() }
      await updateClaim(path, next)
      Object.assign(claim, next)
    },
    async release() {
      const current = await readClaim(path)
      if (current?.claim_id === claim.claim_id) await rm(path, { recursive: true, force: true })
    },
  }
}
