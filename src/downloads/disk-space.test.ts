import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { availableDiskSpace } from './disk-space.js'

let data: string
let outside: string

beforeEach(async () => {
  data = await mkdtemp(join(tmpdir(), 'atomic-disk-space-'))
  outside = await mkdtemp(join(tmpdir(), 'atomic-disk-space-outside-'))
})
afterEach(async () => {
  await rm(data, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

describe('availableDiskSpace', () => {
  it('answers for the data folder when no path is given, with the real probe', async () => {
    const bytes = await availableDiskSpace(data, undefined)
    expect(typeof bytes).toBe('number')
    expect(bytes as number).toBeGreaterThan(0)
  })

  it('answers for a path that does not exist yet, as a download target usually does not', async () => {
    const probed: string[] = []
    const bytes = await availableDiskSpace(data, join(data, 'diffusion', 'backends', 'tag', 'metal'), {
      availableSpace: async (path) => {
        probed.push(path)
        return 123
      },
    })
    expect(bytes).toBe(123)
    expect(probed).toHaveLength(1)
    expect(probed[0]?.endsWith(join('diffusion', 'backends', 'tag', 'metal'))).toBe(true)
  })

  it('is null, not an error, when the platform cannot say', async () => {
    expect(await availableDiskSpace(data, null, { availableSpace: async () => undefined })).toBeNull()
  })

  it.each([
    ['a relative path', 'diffusion/models'],
    ['an empty path', ''],
    ['a path with a NUL byte', '/tmp/a\0b'],
    ['something that is not a string', 42],
  ])('refuses %s', async (_name, path) => {
    await expect(availableDiskSpace(data, path)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      message: 'Disk space needs an absolute path.',
    })
  })

  it('refuses a path outside the data folder, including one that only climbs out of it', async () => {
    await expect(availableDiskSpace(data, outside)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      message: 'Disk space is only reported inside the data folder.',
    })
    await expect(availableDiskSpace(data, join(data, '..', 'elsewhere'))).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
  })

  it.skipIf(process.platform === 'win32')(
    'follows a symlink in the existing part of the path before deciding where it lands',
    async () => {
      await mkdir(join(data, 'diffusion'), { recursive: true })
      await symlink(outside, join(data, 'diffusion', 'escape'))
      await expect(
        availableDiskSpace(data, join(data, 'diffusion', 'escape', 'models'))
      ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    }
  )
})
