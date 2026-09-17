/**
 * `<data>/local-api-server.json`: where the Local API Server is, for processes that cannot ask the
 * app — `server status` and agents configured against it. A hint, not a source of truth: a crashed
 * writer leaves `running: true` behind, so readers confirm over HTTP.
 *
 * Ported from: src-tauri/src/core/server/state_file.rs. Contract: test/fixtures/app/state-file.
 *
 * The byte layout matches serde's pretty printer, and the reader is as strict as serde's derive:
 * a missing field, a wrong type or a port outside u16 rejects the whole file and yields the
 * defaults. The API key itself is never written or read — only whether one is required.
 *
 * Until stage 4e hands the writer over, the app writes this file and the core does not.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface ServerStateFile {
  running: boolean
  host: string
  /** The port actually bound, which differs from the requested one when that was 0. */
  port: number
  prefix: string
  requires_api_key: boolean
  /** The writer's pid, for diagnostics; 0 when stopped. */
  pid: number
}

export const DEFAULT_SERVER_STATE: Readonly<ServerStateFile> = Object.freeze({
  running: false,
  host: '127.0.0.1',
  port: 1337,
  prefix: '/v1',
  requires_api_key: false,
  pid: 0,
})

function isUint(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max
}

/** Parse the file's text; anything serde would reject reads as the defaults. Unknown keys are ignored. */
export function parseServerState(text: string | undefined): ServerStateFile {
  if (text === undefined) return { ...DEFAULT_SERVER_STATE }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ...DEFAULT_SERVER_STATE }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ...DEFAULT_SERVER_STATE }
  const o = raw as Record<string, unknown>
  if (
    typeof o['running'] !== 'boolean' ||
    typeof o['host'] !== 'string' ||
    !isUint(o['port'], 0xffff) ||
    typeof o['prefix'] !== 'string' ||
    typeof o['requires_api_key'] !== 'boolean' ||
    !isUint(o['pid'], 0xffffffff)
  ) {
    return { ...DEFAULT_SERVER_STATE }
  }
  return {
    running: o['running'],
    host: o['host'],
    port: o['port'],
    prefix: o['prefix'],
    requires_api_key: o['requires_api_key'],
    pid: o['pid'],
  }
}

/** serde's pretty print: two-space indent, fields in declaration order, no trailing newline. */
export function serializeServerState(state: ServerStateFile): string {
  const ordered: ServerStateFile = {
    running: state.running,
    host: state.host,
    port: state.port,
    prefix: state.prefix,
    requires_api_key: state.requires_api_key,
    pid: state.pid,
  }
  return JSON.stringify(ordered, null, 2)
}

/** Where to connect, without the prefix. `0.0.0.0` is a bind address, never a connect address. */
export function serverBaseUrl(state: Pick<ServerStateFile, 'host' | 'port'>): string {
  const host = state.host === '0.0.0.0' ? DEFAULT_SERVER_STATE.host : state.host
  return `http://${host}:${state.port}`
}

export function serverApiUrl(state: Pick<ServerStateFile, 'host' | 'port' | 'prefix'>): string {
  return `${serverBaseUrl(state)}${state.prefix}`
}

export type StateFileLogger = (message: string) => void

export async function readServerStateFile(path: string): Promise<ServerStateFile> {
  return parseServerState(await readFile(path, 'utf8').catch(() => undefined))
}

/** Best-effort: a server must not fail to start because its hint file could not be written. */
export async function writeServerStateFile(
  path: string,
  state: ServerStateFile,
  log?: StateFileLogger
): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true })
  } catch (e) {
    log?.(`Cannot create data folder for local-api-server.json: ${(e as Error).message}`)
    return
  }
  await writeFile(path, serializeServerState(state)).catch((e: Error) =>
    log?.(`Cannot write ${path}: ${e.message}`)
  )
}

export function markServerRunning(
  path: string,
  running: { host: string; port: number; prefix: string; requiresApiKey: boolean; pid?: number },
  log?: StateFileLogger
): Promise<void> {
  return writeServerStateFile(
    path,
    {
      running: true,
      host: running.host,
      port: running.port,
      prefix: running.prefix,
      requires_api_key: running.requiresApiKey,
      pid: running.pid ?? process.pid,
    },
    log
  )
}

/** Keep the last known address so a reader can still say where the server would be. */
export async function markServerStopped(path: string, log?: StateFileLogger): Promise<void> {
  const state = await readServerStateFile(path)
  await writeServerStateFile(path, { ...state, running: false, pid: 0 }, log)
}
