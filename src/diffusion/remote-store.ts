/**
 * Remote video jobs still running at a provider (`<data>/diffusion/remote-jobs.json`). A clip takes
 * minutes and the provider bills for it whether or not anybody waits, so a job submitted before the
 * core stopped is polled again when it starts, never submitted twice. One small JSON document,
 * rewritten whole under a lock; an unreadable one is treated as empty.
 */

import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { MediaTarget, VideoGenerateRequest } from '../contracts/index.js'
import { writeAtomic } from './gallery.js'
import { AsyncMutex } from './mutex.js'

type Plain = string | number | boolean | null

/** What a submit answered, as the adapter needs it to poll, download and cancel. */
export interface StoredSubmission {
  id: string
  data?: Record<string, Plain>
}

export interface StoredRemoteVideoJob {
  jobId: string
  target: MediaTarget
  submission: StoredSubmission
  /** The request with inline images blanked, for the recipe. */
  request: VideoGenerateRequest
  /** The seed the job ran with, when the model takes one. */
  seed?: number
  createdAtMs: number
  startedAtMs: number
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

function isPlainRecord(value: unknown): value is Record<string, Plain> {
  if (!isObject(value)) return false
  return Object.values(value).every(
    (item) => item === null || ['string', 'number', 'boolean'].includes(typeof item)
  )
}

/** One stored entry, or `undefined` when it is not one this core wrote. */
export function parseStoredJob(raw: unknown): StoredRemoteVideoJob | undefined {
  if (!isObject(raw) || !isObject(raw['target']) || !isObject(raw['submission']) || !isObject(raw['request']))
    return undefined
  const { target, submission } = raw
  if (typeof raw['jobId'] !== 'string' || !/^[a-f0-9]{32}$/.test(raw['jobId'])) return undefined
  if (typeof target['provider'] !== 'string' || typeof target['model'] !== 'string') return undefined
  if (typeof submission['id'] !== 'string' || submission['id'] === '') return undefined
  if (submission['data'] !== undefined && !isPlainRecord(submission['data'])) return undefined
  if (typeof raw['createdAtMs'] !== 'number' || typeof raw['startedAtMs'] !== 'number') return undefined
  const request = raw['request'] as unknown as VideoGenerateRequest
  if (typeof request.prompt !== 'string') return undefined
  return {
    jobId: raw['jobId'],
    target: { provider: target['provider'], model: target['model'] },
    submission:
      submission['data'] === undefined
        ? { id: submission['id'] }
        : { id: submission['id'], data: submission['data'] as Record<string, Plain> },
    request,
    ...(typeof raw['seed'] === 'number' ? { seed: raw['seed'] } : {}),
    createdAtMs: raw['createdAtMs'],
    startedAtMs: raw['startedAtMs'],
  }
}

export class RemoteJobStore {
  private readonly lock = new AsyncMutex()

  constructor(private readonly path: string) {}

  private async read(): Promise<StoredRemoteVideoJob[]> {
    const text = await readFile(this.path, 'utf8').catch(() => undefined)
    if (text === undefined) return []
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      return []
    }
    const jobs = isObject(raw) && Array.isArray(raw['jobs']) ? raw['jobs'] : []
    return jobs.map(parseStoredJob).filter((job): job is StoredRemoteVideoJob => job !== undefined)
  }

  private async write(jobs: StoredRemoteVideoJob[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true }).catch(() => {})
    await writeAtomic(this.path, `${JSON.stringify({ version: 1, jobs }, null, 2)}\n`)
  }

  list(): Promise<StoredRemoteVideoJob[]> {
    return this.lock.run(() => this.read())
  }

  /** Add or replace the entry of `job.jobId`. */
  put(job: StoredRemoteVideoJob): Promise<void> {
    return this.lock.run(async () => {
      const jobs = (await this.read()).filter((entry) => entry.jobId !== job.jobId)
      jobs.push(job)
      await this.write(jobs)
    })
  }

  remove(jobId: string): Promise<void> {
    return this.lock.run(async () => {
      const jobs = await this.read()
      const kept = jobs.filter((entry) => entry.jobId !== jobId)
      if (kept.length !== jobs.length) await this.write(kept)
    })
  }
}
