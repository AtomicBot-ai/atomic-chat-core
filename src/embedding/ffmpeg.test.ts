import { describe, expect, it } from 'vitest'
import { FFMPEG_EXTRA_DIRS, ffmpegSearchDirs, findFfmpegDir, pathOf, withPathDir } from './ffmpeg.js'

describe('ffmpegSearchDirs', () => {
  it('looks in PATH first, then where Homebrew and the usual installers put it, once each', () => {
    expect(ffmpegSearchDirs('darwin', '/usr/bin:/bin:/usr/local/bin:')).toEqual([
      '/usr/bin',
      '/bin',
      '/usr/local/bin',
      '/opt/homebrew/bin',
      '/opt/local/bin',
    ])
    expect(ffmpegSearchDirs('linux', '')).toEqual(FFMPEG_EXTRA_DIRS.linux)
  })

  it('splits a Windows PATH on semicolons and compares folders without case', () => {
    expect(ffmpegSearchDirs('win32', 'C:\\ffmpeg\\bin;c:\\FFMPEG\\BIN;C:\\Windows')).toEqual([
      'C:\\ffmpeg\\bin',
      'C:\\Windows',
    ])
  })
})

describe('pathOf / withPathDir', () => {
  it('reads and extends PATH in the key the environment uses', () => {
    expect(pathOf({ Path: 'C:\\x' })).toBe('C:\\x')
    expect(pathOf({})).toBe('')
    expect(withPathDir({ PATH: '/usr/bin:/bin' }, '/opt/homebrew/bin', 'darwin')).toEqual({
      PATH: '/opt/homebrew/bin:/usr/bin:/bin',
    })
    expect(withPathDir({ Path: 'C:\\Windows' }, 'C:\\ffmpeg\\bin', 'win32')).toEqual({
      Path: 'C:\\ffmpeg\\bin;C:\\Windows',
    })
    expect(withPathDir({}, '/opt/homebrew/bin', 'darwin')).toEqual({ PATH: '/opt/homebrew/bin' })
  })

  it('leaves a PATH that already has the folder as it is', () => {
    const env = { PATH: '/usr/bin:/opt/homebrew/bin' }
    expect(withPathDir(env, '/opt/homebrew/bin', 'darwin')).toBe(env)
  })
})

describe('findFfmpegDir', () => {
  it('finds ffmpeg in Homebrew when the Finder gave the app a bare PATH', async () => {
    const files = new Set(['/opt/homebrew/bin/ffmpeg'])
    expect(await findFfmpegDir('darwin', { PATH: '/usr/bin:/bin' }, async (p) => files.has(p))).toBe(
      '/opt/homebrew/bin'
    )
  })

  it('prefers the PATH, looks for ffmpeg.exe on Windows, and answers undefined without one', async () => {
    const files = new Set(['/home/me/bin/ffmpeg', '/usr/local/bin/ffmpeg', 'C:\\tools\\ffmpeg.exe'])
    const isFile = async (p: string) => files.has(p)
    expect(await findFfmpegDir('linux', { PATH: '/home/me/bin' }, isFile)).toBe('/home/me/bin')
    expect(await findFfmpegDir('win32', { Path: 'C:\\tools' }, isFile)).toBe('C:\\tools')
    expect(await findFfmpegDir('darwin', { PATH: '/usr/bin' }, async () => false)).toBeUndefined()
  })

  it('reads the real file system by default', async () => {
    expect(await findFfmpegDir('linux', { PATH: '/definitely/not/here' }, undefined)).toSatisfy(
      (dir: string | undefined) => dir === undefined || typeof dir === 'string'
    )
  })
})
