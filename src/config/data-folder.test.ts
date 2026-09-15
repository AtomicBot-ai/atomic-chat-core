import { describe, expect, it } from 'vitest'
import type { DataFolderEnv } from './data-folder.js'
import {
  configDir,
  dataDir,
  defaultDataFolder,
  parseAppConfiguration,
  resolveConfigFilePath,
  resolveDataFolder,
} from './data-folder.js'

const env = (
  platform: NodeJS.Platform,
  opts: { env?: NodeJS.ProcessEnv; existing?: string[]; files?: Record<string, string> } = {}
): DataFolderEnv => ({
  platform,
  env: opts.env ?? {},
  homedir: platform === 'win32' ? 'C:\\Users\\u' : '/home/u',
  exists: (p) => (opts.existing ?? []).includes(p),
  readFile: (p) => opts.files?.[p],
})

describe('dataDir / configDir', () => {
  it('macOS uses Application Support for both', () => {
    expect(dataDir(env('darwin'))).toBe('/home/u/Library/Application Support')
    expect(configDir(env('darwin'))).toBe('/home/u/Library/Application Support')
  })
  it('Windows uses APPDATA (Roaming) with a home fallback', () => {
    expect(dataDir(env('win32', { env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' } }))).toBe(
      'C:\\Users\\u\\AppData\\Roaming'
    )
    expect(dataDir(env('win32'))).toContain('AppData')
  })
  it('Linux honours XDG and falls back to ~/.local/share and ~/.config', () => {
    expect(dataDir(env('linux'))).toBe('/home/u/.local/share')
    expect(configDir(env('linux'))).toBe('/home/u/.config')
    expect(dataDir(env('linux', { env: { XDG_DATA_HOME: '/x/data' } }))).toBe('/x/data')
    expect(configDir(env('linux', { env: { XDG_CONFIG_HOME: '/x/cfg' } }))).toBe('/x/cfg')
  })
})

describe('resolveConfigFilePath', () => {
  it('prefers the legacy Atomic-Chat dir when it exists, else chat.atomic.app', () => {
    const legacy = '/home/u/Library/Application Support/Atomic-Chat'
    expect(resolveConfigFilePath(env('darwin', { existing: [legacy] }))).toBe(`${legacy}/settings.json`)
    expect(resolveConfigFilePath(env('darwin'))).toBe(
      '/home/u/Library/Application Support/chat.atomic.app/settings.json'
    )
  })
  it('looks for the legacy dir under ~/.config on Linux', () => {
    const legacy = '/home/u/.config/Atomic-Chat'
    expect(resolveConfigFilePath(env('linux', { existing: [legacy] }))).toBe(`${legacy}/settings.json`)
    expect(resolveConfigFilePath(env('linux'))).toBe('/home/u/.local/share/chat.atomic.app/settings.json')
  })
})

describe('defaultDataFolder / resolveDataFolder', () => {
  it('builds <data_dir>/<APP_NAME|Atomic Chat>/data and strips a trailing .ai.app', () => {
    expect(defaultDataFolder(env('darwin'))).toBe('/home/u/Library/Application Support/Atomic Chat/data')
    expect(defaultDataFolder(env('linux', { env: { APP_NAME: 'Jan' } }))).toBe(
      '/home/u/.local/share/Jan/data'
    )
  })
  it('env override wins, then settings.json, then the default', () => {
    expect(resolveDataFolder(env('darwin', { env: { ATOMIC_CORE_DATA_FOLDER: '/custom' } }))).toBe('/custom')
    const cfg = '/home/u/Library/Application Support/chat.atomic.app/settings.json'
    expect(
      resolveDataFolder(
        env('darwin', { files: { [cfg]: '{"data_folder":"/moved","autostart_preference":"enabled"}' } })
      )
    ).toBe('/moved')
    expect(resolveDataFolder(env('darwin', { files: { [cfg]: 'not json' } }))).toBe(
      '/home/u/Library/Application Support/Atomic Chat/data'
    )
    expect(resolveDataFolder(env('darwin'))).toBe('/home/u/Library/Application Support/Atomic Chat/data')
  })
  it('parseAppConfiguration defaults autostart to unmanaged and rejects a missing data_folder', () => {
    expect(parseAppConfiguration('{"data_folder":"/d"}')).toEqual({
      data_folder: '/d',
      autostart_preference: 'unmanaged',
    })
    expect(
      parseAppConfiguration('{"data_folder":"/d","autostart_preference":"weird"}')?.autostart_preference
    ).toBe('unmanaged')
    expect(parseAppConfiguration('{}')).toBeUndefined()
    expect(parseAppConfiguration('null')).toBeUndefined()
  })
})
