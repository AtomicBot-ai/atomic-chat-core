/**
 * Data-folder and config-file resolution, following the app exactly
 * (`src-tauri/src/core/app/{commands,models,constants}.rs`).
 *
 * The app keeps a tiny `settings.json` (`{ data_folder, autostart_preference }`) in its config dir
 * and everything else under `<data_folder>`. Two config dirs exist for historical reasons:
 * the legacy `Atomic-Chat` (Cargo package name) and the current `chat.atomic.app` (bundle id);
 * the legacy one wins whenever it exists. The Rust CLI (`resolve_config_file_path`) only ever looks
 * at the legacy dir — the core follows the app, which is the writer.
 *
 * Pure: every environment fact is injected so the Windows/Linux branches are testable anywhere.
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const CONFIGURATION_FILE_NAME = 'settings.json'
export const DEFAULT_APP_NAME = 'Atomic Chat'
/** Tauri bundle identifier — current config dir name. */
export const APP_IDENTIFIER = 'chat.atomic.app'
/** Cargo package name — legacy config dir name. */
export const LEGACY_PACKAGE_NAME = 'Atomic-Chat'
/** Env var the core honours before any file (CLI `--data-folder` sets it too). */
export const DATA_FOLDER_ENV = 'ATOMIC_CORE_DATA_FOLDER'

export type AutostartPreference = 'pending_default_on' | 'unmanaged' | 'enabled' | 'disabled'

export interface AppConfiguration {
  data_folder: string
  autostart_preference: AutostartPreference
}

/** The real environment: what every caller outside tests passes to the resolvers below. */
export function nodeDataFolderEnv(env: NodeJS.ProcessEnv = process.env): DataFolderEnv {
  return {
    platform: process.platform,
    env,
    homedir: homedir(),
    exists: (path) => existsSync(path),
    readFile: (path) => {
      try {
        return readFileSync(path, 'utf8')
      } catch {
        return undefined
      }
    },
  }
}

export interface DataFolderEnv {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  homedir: string
  exists: (path: string) => boolean
  readFile: (path: string) => string | undefined
}

/** `dirs::data_dir()` — Roaming AppData / Application Support / XDG data. */
export function dataDir(e: DataFolderEnv): string {
  if (e.platform === 'win32') return e.env['APPDATA'] ?? join(e.homedir, 'AppData', 'Roaming')
  if (e.platform === 'darwin') return join(e.homedir, 'Library', 'Application Support')
  return e.env['XDG_DATA_HOME'] ?? join(e.homedir, '.local', 'share')
}

/** `dirs::config_dir()` — only differs from data_dir on Linux (`~/.config`). */
export function configDir(e: DataFolderEnv): string {
  if (e.platform === 'win32') return e.env['APPDATA'] ?? join(e.homedir, 'AppData', 'Roaming')
  if (e.platform === 'darwin') return join(e.homedir, 'Library', 'Application Support')
  return e.env['XDG_CONFIG_HOME'] ?? join(e.homedir, '.config')
}

/**
 * Where the app reads/writes `settings.json` (`get_configuration_file_path`): the legacy
 * `Atomic-Chat` dir when it exists, otherwise `chat.atomic.app`. On Linux the legacy dir is under
 * `config_dir`, elsewhere it sits beside the current one under `data_dir`.
 */
export function resolveConfigFilePath(e: DataFolderEnv): string {
  const current = join(dataDir(e), APP_IDENTIFIER)
  const legacy =
    e.platform === 'linux' ? join(configDir(e), LEGACY_PACKAGE_NAME) : join(dataDir(e), LEGACY_PACKAGE_NAME)
  return join(e.exists(legacy) ? legacy : current, CONFIGURATION_FILE_NAME)
}

/** `build_default_data_folder` + the `.ai.app` suffix strip of `default_data_folder_path`. */
export function defaultDataFolder(e: DataFolderEnv): string {
  const appName = e.env['APP_NAME'] ?? DEFAULT_APP_NAME
  const path = join(dataDir(e), appName, 'data')
  return path.endsWith('.ai.app') ? path.slice(0, -'.ai.app'.length) : path
}

/** Parse the app's `settings.json`; `autostart_preference` defaults to `unmanaged` like serde. */
export function parseAppConfiguration(text: string): AppConfiguration | undefined {
  try {
    const raw = JSON.parse(text) as Partial<AppConfiguration> | null
    if (!raw || typeof raw.data_folder !== 'string') return undefined
    const pref = raw.autostart_preference
    const autostart: AutostartPreference =
      pref === 'pending_default_on' || pref === 'unmanaged' || pref === 'enabled' || pref === 'disabled'
        ? pref
        : 'unmanaged'
    return { data_folder: raw.data_folder, autostart_preference: autostart }
  } catch {
    return undefined
  }
}

/**
 * `<data>`: explicit env override → `settings.json` `data_folder` → default location.
 * Never creates anything.
 */
export function resolveDataFolder(e: DataFolderEnv): string {
  const override = e.env[DATA_FOLDER_ENV]
  if (override !== undefined && override.trim() !== '') return override
  const text = e.readFile(resolveConfigFilePath(e))
  const config = text === undefined ? undefined : parseAppConfiguration(text)
  return config?.data_folder ?? defaultDataFolder(e)
}
