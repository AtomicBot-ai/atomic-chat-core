import { describe, expect, it } from 'vitest'
import { FS_RETRY_DELAYS_MS, TRANSIENT_FS_CODES, isTransientFsError, retryTransientFs } from './fs-retry.js'

const err = (code: string) => Object.assign(new Error(`${code}: operation not permitted`), { code })

/** An op that fails with `codes` in turn, then answers `done`. */
function failing(codes: string[]) {
  let calls = 0
  return {
    get calls() {
      return calls
    },
    op: async () => {
      const code = codes[calls++]
      if (code) throw err(code)
      return 'done'
    },
  }
}

describe('isTransientFsError', () => {
  it.each([
    ['EPERM', true],
    ['EBUSY', true],
    ['EACCES', true],
    ['ENOTEMPTY', true],
    ['ENOSPC', false],
    ['ENOENT', false],
  ])('%s → %s', (code, expected) => expect(isTransientFsError(err(code))).toBe(expected))
  it('reads nothing into an error without a code', () => {
    expect(isTransientFsError(new Error('x'))).toBe(false)
    expect(isTransientFsError(undefined)).toBe(false)
    expect(isTransientFsError({ code: 5 })).toBe(false)
    expect([...TRANSIENT_FS_CODES].sort()).toEqual(['EACCES', 'EBUSY', 'ENOTEMPTY', 'EPERM'])
  })
})

describe('retryTransientFs', () => {
  it('waits out a held handle on Windows, about ten seconds in all', async () => {
    const slept: number[] = []
    const sleep = async (ms: number) => void slept.push(ms)
    const held = failing(['EBUSY', 'EPERM', 'EACCES'])
    await expect(retryTransientFs(held.op, { platform: 'win32', sleep })).resolves.toBe('done')
    expect(held.calls).toBe(4)
    expect(slept).toEqual([100, 250, 500])
    expect(FS_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0)).toBe(10_000)

    const forever = failing(Array(20).fill('EPERM'))
    slept.length = 0
    await expect(retryTransientFs(forever.op, { platform: 'win32', sleep })).rejects.toMatchObject({
      code: 'EPERM',
    })
    expect(forever.calls).toBe(FS_RETRY_DELAYS_MS.length + 1)
    expect(slept).toEqual([...FS_RETRY_DELAYS_MS])
  })

  it('fails at once on another code, and on every code off Windows', async () => {
    const full = failing(['ENOSPC'])
    await expect(
      retryTransientFs(full.op, { platform: 'win32', sleep: async () => {} })
    ).rejects.toMatchObject({
      code: 'ENOSPC',
    })
    expect(full.calls).toBe(1)
    const mac = failing(['EBUSY'])
    await expect(retryTransientFs(mac.op, { platform: 'darwin' })).rejects.toMatchObject({ code: 'EBUSY' })
    expect(mac.calls).toBe(1)
    const real = failing(['EBUSY'])
    await expect(retryTransientFs(real.op, { platform: 'win32', delaysMs: [1] })).resolves.toBe('done')
    await expect(retryTransientFs(async () => 7)).resolves.toBe(7)
  })
})
