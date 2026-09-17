/**
 * Reads what the desktop app's legacy runtime is holding, so the core does not load a model the app
 * already has (PLAN.md §3.4, "Coexistence with legacy").
 *
 * Until the app becomes a core client, both runtimes can be live on one data folder. Two copies of
 * one model double the VRAM and race for the GPU, and neither side can ask the other over IPC — so
 * the app's llama.cpp plugin mirrors its session table to
 * `<data>/atomic-core/legacy-runtime.json` and the core refuses before it mutates anything.
 *
 * Advisory by design: a file whose PID is gone is ignored (a crashed app holds nothing), an
 * unreadable or malformed file means "nothing known", and the check never blocks on IO for long.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AtomicCoreError } from '../contracts/index.js'
import type { DataLayout } from '../config/index.js'
import { isProcessAlive, processStartEpoch } from './process-identity.js'

export const LEGACY_RUNTIME_FILE = 'legacy-runtime.json'

export interface LegacySession {
  model_id: string
  port: number
  pid: number
  is_embedding: boolean
}

export interface LegacyRuntimeState {
  /** The desktop app's PID. */
  pid: number
  owner_start_id?: string
  updated_at: number
  provider: string
  sessions: LegacySession[]
}

export interface LegacyGuardDeps {
  alive?: (pid: number) => boolean
  startId?: (pid: number) => Promise<string | undefined>
  read?: (path: string) => Promise<string | undefined>
}

export function parseLegacyRuntimeState(text: string): LegacyRuntimeState | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  if (typeof r['pid'] !== 'number') return undefined
  const sessions = Array.isArray(r['sessions']) ? r['sessions'] : []
  return {
    pid: r['pid'],
    ...(typeof r['owner_start_id'] === 'string' ? { owner_start_id: r['owner_start_id'] } : {}),
    updated_at: typeof r['updated_at'] === 'number' ? r['updated_at'] : 0,
    provider: typeof r['provider'] === 'string' ? r['provider'] : 'llamacpp-upstream',
    sessions: sessions.filter(isLegacySession),
  }
}

function isLegacySession(value: unknown): value is LegacySession {
  if (!value || typeof value !== 'object') return false
  const s = value as Record<string, unknown>
  return typeof s['model_id'] === 'string' && typeof s['pid'] === 'number'
}

/**
 * What the app holds right now, or `undefined` when it holds nothing we can prove: no file, a file
 * we cannot parse, or one written by a process that is gone.
 */
export async function readLegacyRuntime(
  layout: DataLayout,
  deps: LegacyGuardDeps = {}
): Promise<LegacyRuntimeState | undefined> {
  const read =
    deps.read ??
    ((path: string) =>
      readFile(path, 'utf8').then(
        (t) => t,
        () => undefined
      ))
  const text = await read(join(layout.core.dir, LEGACY_RUNTIME_FILE))
  if (text === undefined) return undefined
  const state = parseLegacyRuntimeState(text)
  if (!state) return undefined
  const alive = deps.alive ?? isProcessAlive
  // A crashed app leaves a stale table behind; its backends are the reaper's problem, not a reason
  // to refuse the user a model.
  if (!alive(state.pid)) return undefined
  if (state.owner_start_id) {
    const actual = await (deps.startId ?? processStartEpoch)(state.pid)
    // Fail closed when the identity cannot be established; only a proven mismatch makes this stale.
    if (actual && actual !== state.owner_start_id) return undefined
  }
  return state
}

/** The live legacy session for a model, if the app has it loaded. */
export function legacySessionFor(
  state: LegacyRuntimeState | undefined,
  modelId: string
): LegacySession | undefined {
  return state?.sessions.find((s) => s.model_id === modelId)
}

/**
 * Refuse a load the desktop app already owns. Called before anything is spawned, so the user gets a
 * sentence they can act on instead of a second copy of the model competing for the GPU.
 */
export async function assertNotLoadedByLegacy(
  layout: DataLayout,
  modelId: string,
  deps: LegacyGuardDeps = {}
): Promise<void> {
  const state = await readLegacyRuntime(layout, deps)
  const session = legacySessionFor(state, modelId)
  if (!session) return
  throw new AtomicCoreError(
    'CORE_ALREADY_RUNNING',
    `The Atomic Chat app already has "${modelId}" loaded.`,
    `unload it in the app, or use it at http://127.0.0.1:${session.port} (app pid ${(state as LegacyRuntimeState).pid})`
  )
}
