import { describe, expect, it } from 'vitest'
import {
  checkFreeSpace,
  checkPathWithinLimit,
  classifyIoError,
  diskErrToString,
  diskFaultMessage,
  formatBytes,
  FREE_SPACE_HEADROOM,
  remainingBytes,
} from './disk.js'

const err = (code: string, message = `${code} happened`) => Object.assign(new Error(message), { code })

describe('classifyIoError / diskErrToString', () => {
  it.each([
    ['ENOSPC', 'disk_full'],
    ['EDQUOT', 'disk_full'],
    ['EACCES', 'disk_permission'],
    ['EROFS', 'disk_permission'],
    ['ETXTBSY', 'disk_file_locked'],
    ['EBUSY', 'disk_file_locked'],
    ['ENAMETOOLONG', 'disk_path_too_long'],
    ['ENODEV', 'disk_device_lost'],
    ['ENOENT', 'disk_device_lost'],
    ['EWHATEVER', 'disk_io'],
  ])('%s → %s', (code, tag) => expect(classifyIoError(err(code))).toBe(tag))
  it('handles non-errno errors and keeps the message body after the tag', () => {
    expect(classifyIoError(new Error('x'))).toBe('disk_io')
    expect(classifyIoError('str')).toBe('disk_io')
    expect(diskErrToString(err('ENOSPC', 'no space left on device'))).toBe(
      'Error: [disk_full] no space left on device'
    )
    expect(diskFaultMessage('disk_io', 'd')).toBe('Error: [disk_io] d')
  })
})

describe('preflight helpers', () => {
  it('remainingBytes discounts partials and never underflows', () => {
    expect(remainingBytes(10_000, [4096])).toBe(10_000 - 4096)
    expect(remainingBytes(10_000, [])).toBe(10_000)
    expect(remainingBytes(1_000, [4096])).toBe(0)
  })
  it('formatBytes matches the Rust rendering', () => {
    expect(formatBytes(0)).toBe('1 MB')
    expect(formatBytes(700 * 1024 * 1024)).toBe('700 MB')
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3.0 GB')
  })
  it('checkFreeSpace passes when nothing is needed, the volume is unknown, or there is room', () => {
    expect(checkFreeSpace(0, 0)).toBeUndefined()
    expect(checkFreeSpace(undefined, 10)).toBeUndefined()
    expect(checkFreeSpace(1024 + FREE_SPACE_HEADROOM, 1024)).toBeUndefined()
    expect(checkFreeSpace(1024, 1024)).toMatch(/^Error: \[disk_full\] Not enough free disk space/)
  })
  it('checkPathWithinLimit only bites on Windows and exempts verbatim paths', () => {
    const long = `C:\\${'x'.repeat(300)}\\model.gguf`
    expect(checkPathWithinLimit(long, 'win32')).toMatch(/^Error: \[disk_path_too_long\]/)
    expect(checkPathWithinLimit('C:\\jan\\model.gguf', 'win32')).toBeUndefined()
    expect(checkPathWithinLimit(`\\\\?\\${long}`, 'win32')).toBeUndefined()
    expect(checkPathWithinLimit(`/${'x'.repeat(300)}/model.gguf`, 'linux')).toBeUndefined()
  })
})
