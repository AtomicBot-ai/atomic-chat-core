import { expect, it, vi } from 'vitest'
import { runInNpuStage, windowsNpuIo } from './windows-npu-io.js'
import { WINDOWS_NPU_DRIVER } from '../../runtime/fastflowlm/environment/index.js'
it('downloads only the pinned CAB and rejects truncated bytes before writing', async () => {
  const fetch = vi.fn(async () => new Response('different'))
  await expect(windowsNpuIo({ fetch }).download('unused')).rejects.toThrow('SHA-256')
  expect(fetch).toHaveBeenCalledWith(WINDOWS_NPU_DRIVER.url, {
    redirect: 'error',
    signal: expect.any(AbortSignal),
  })
})

it('records a locked stage separately from a completed install that requires a reboot', async () => {
  const warn = vi.fn(),
    remove = vi.fn(async () => {
      throw Error('EBUSY')
    })
  expect(await runInNpuStage('stage', async () => 3010, remove, warn)).toBe(3010)
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('EBUSY'))
  await expect(
    runInNpuStage(
      'stage',
      async () => {
        throw Error('installer failed')
      },
      remove,
      warn
    )
  ).rejects.toThrow('installer failed')
})
