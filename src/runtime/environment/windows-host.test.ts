import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createWsl } from '../wsl/index.js'
import { distributionDirectory, distributionDisk, realWindowsHost } from './windows-host.js'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'windows-host-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('where the distribution lives', () => {
  it('is %LOCALAPPDATA%\\AtomicChat\\wsl\\<name>, with its disk inside', () => {
    const directory = distributionDirectory('C:\\Users\\ada\\AppData\\Local')
    expect(directory).toBe('C:\\Users\\ada\\AppData\\Local\\AtomicChat\\wsl\\AtomicChat')
    expect(distributionDisk(directory)).toBe(`${directory}\\ext4.vhdx`)
  })
})

describe('realWindowsHost', () => {
  const host = (env: Record<string, string>) =>
    realWindowsHost(env, createWsl({ executable: join(dir, 'no-wsl.exe') }), async () => ({
      code: null,
      stdout: '',
      stderr: '',
    }))

  it('reads %UserProfile%\\.wslconfig, and none is null', async () => {
    const h = host({ USERPROFILE: dir, LOCALAPPDATA: dir })
    expect(await h.probeDeps.readWslConfig()).toBeNull()
  })

  it('answers free space at the nearest existing ancestor, and sizes a file', async () => {
    const h = host({ USERPROFILE: dir, LOCALAPPDATA: dir })
    expect(await h.freeDiskBytes(join(dir, 'AtomicChat', 'wsl', 'AtomicChat'))).toBeGreaterThan(0)
    await writeFile(join(dir, 'disk'), 'x'.repeat(10))
    expect(await h.fileSize(join(dir, 'disk'))).toBe(10)
    expect(await h.fileSize(join(dir, 'missing'))).toBeNull()
    expect(await h.probeDeps.pathExists(join(dir, 'disk'))).toBe(true)
    expect(await h.probeDeps.pathExists(join(dir, 'missing'))).toBe(false)
  })

  it('takes the system directory from SystemRoot, never PATH', () => {
    expect(host({ SystemRoot: 'D:\\WIN' }).probeDeps.systemRoot).toBe('D:\\WIN')
  })
})
