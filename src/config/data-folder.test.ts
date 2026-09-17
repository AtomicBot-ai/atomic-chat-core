import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import type { DataFolderEnv } from './data-folder.js'
import {
  configDir,
  dataDir,
  defaultDataFolder,
  nodeDataFolderEnv,
  parseAppConfiguration,
  resolveConfigFilePath,
  resolveDataFolder,
  resolveCliDataFolder,
  assertCliDataFolder,
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
    expect(configDir(env('win32'))).toContain('AppData')
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
  it('keeps CLI data separate on every platform and rejects an explicit app alias', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      const e = env(platform)
      expect(resolveCliDataFolder(e)).not.toBe(resolveDataFolder(e))
      expect(resolveCliDataFolder(e)).toContain('atomic-chat-cli')
      expect(() => assertCliDataFolder(resolveDataFolder(e), e)).toThrow(/application data folder/)
    }
  })
  it('normalizes Windows case and separators even for a future app folder', () => {
    const e = env('win32', { env: { ATOMIC_CORE_DATA_FOLDER: 'C:\\Users\\u\\Atomic Chat\\data' } })
    expect(() => assertCliDataFolder('c:/users/U/ATOMIC CHAT/./data', e)).toThrow(/application data folder/)
  })
  it('rejects the configured app folder even when the CLI has another environment override', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      const base = env(platform, {
        env: { ATOMIC_CORE_DATA_FOLDER: platform === 'win32' ? 'C:\\cli' : '/cli' },
      })
      const configFile = resolveConfigFilePath(base)
      const appPath = platform === 'win32' ? 'C:\\app-data' : '/app-data'
      const e = env(platform, {
        env: base.env,
        files: { [configFile]: JSON.stringify({ data_folder: appPath }) },
      })
      expect(() => assertCliDataFolder(appPath, e)).toThrow(/application data folder/)
      expect(() => assertCliDataFolder(platform === 'win32' ? 'C:\\other' : '/other', e)).not.toThrow()
    }
  })
  it('resolves a symlink ancestor even when multiple path components do not exist', async () => {
    if (process.platform === 'win32') return
    const { mkdir, mkdtemp, rm, symlink } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const root = await mkdtemp(join(tmpdir(), 'atomic-scope-path-'))
    try {
      await mkdir(join(root, 'real'))
      await symlink(join(root, 'real'), join(root, 'alias'))
      const e = env(process.platform, { env: { ATOMIC_CORE_DATA_FOLDER: join(root, 'real/new/data') } })
      expect(() => assertCliDataFolder(join(root, 'alias/new/data'), e)).toThrow(/application data folder/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
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

describe('nodeDataFolderEnv', () => {
  it('wires the real filesystem and this machine, and reads a missing file as undefined', async () => {
    const env = nodeDataFolderEnv({ CUSTOM: '1' })
    expect(env.platform).toBe(process.platform)
    expect(env.env['CUSTOM']).toBe('1')
    expect(env.homedir.length).toBeGreaterThan(0)
    expect(env.exists(env.homedir)).toBe(true)
    expect(env.exists('/definitely/not/here')).toBe(false)
    expect(env.readFile('/definitely/not/here')).toBeUndefined()
    const { writeFile, mkdtemp } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = await mkdtemp(join(tmpdir(), 'atomic-core-env-'))
    await writeFile(join(dir, 'f.json'), '{"a":1}')
    expect(env.readFile(join(dir, 'f.json'))).toBe('{"a":1}')
  })
})
