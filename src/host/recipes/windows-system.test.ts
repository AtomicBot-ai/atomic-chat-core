import { expect, it, vi } from 'vitest'
import { systemEnvironment, windowsSystemDirectory } from './windows-system.js'
it('uses the kernel system directory and only its system tools and modules', async () => {
  const dir = String.raw`D:\Windows\System32`
  const resolve = vi.fn(async () => dir)
  expect(await windowsSystemDirectory(resolve)).toBe(dir)
  expect(resolve).toHaveBeenCalledWith(String.raw`\\?\GLOBALROOT\SystemRoot\System32`)
  expect(systemEnvironment(dir, 'stage')).toMatchObject({
    PATH: dir,
    SystemRoot: String.raw`D:\Windows`,
    TEMP: 'stage',
    PSModulePath: String.raw`D:\Windows\System32\WindowsPowerShell\v1.0\Modules`,
  })
})
