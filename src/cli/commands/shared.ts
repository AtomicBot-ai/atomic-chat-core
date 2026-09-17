/** Helpers used by more than one CLI command: the data folder, sizes, paths and server URLs. */

import { isAbsolute, resolve } from 'node:path'
import type { LocalApiServerState } from '../../contracts/index.js'
import {
  assertCliDataFolder,
  dataLayout,
  nodeDataFolderEnv,
  resolveCliDataFolder,
} from '../../config/index.js'
import type { DataLayout } from '../../config/index.js'
import type { CliIo } from '../io.js'

export function layoutFor(values: Record<string, unknown>, io: CliIo): DataLayout {
  const explicit = typeof values['data-folder'] === 'string' ? (values['data-folder'] as string) : undefined
  const env = nodeDataFolderEnv(io.env)
  const root = explicit ?? resolveCliDataFolder(env)
  assertCliDataFolder(root, env)
  return dataLayout(root)
}

/** Human-readable size, same thresholds as the Rust `fmt_bytes`. */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return unit === 0 ? `${value} ${units[unit]}` : `${value.toFixed(1)} ${units[unit]}`
}

export function pathValue(value: unknown, cwd: string): string | undefined {
  if (typeof value !== 'string' || !value) return undefined
  return isAbsolute(value) ? value : resolve(cwd, value)
}

export function baseUrl(state: LocalApiServerState): string {
  const host = state.host === '0.0.0.0' ? '127.0.0.1' : state.host
  return `http://${host}:${state.port}`
}

export function apiUrl(state: LocalApiServerState): string {
  return `${baseUrl(state)}${state.prefix}`
}
