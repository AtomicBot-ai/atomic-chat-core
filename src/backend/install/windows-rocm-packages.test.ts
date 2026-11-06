import { expect, it } from 'vitest'
import { windowsRocmPackages } from './windows-rocm-packages.js'

const gpu = { vendor: 'AMD', vulkan_info: { device_id: 0x1114 } }
const backend = 'win-rocm-10.0-x64'

it('selects a pinned ABI and deduplicated packages for every known AMD GPU', () => {
  const packages = windowsRocmPackages(backend, [
    gpu,
    gpu,
    { vendor: 'AMD', vulkan_info: { device_id: 0x744c } },
  ])
  expect(packages.map((p) => p.name)).toEqual([
    'rocm_sdk_libraries',
    'rocm_sdk_device_gfx1100',
    'rocm_sdk_device_gfx1152',
  ])
  expect(packages.every((p) => p.url.includes('-10.0.0-py3-none-win_amd64.whl'))).toBe(true)
  expect(() => windowsRocmPackages('win-rocm-7.14-x64', [gpu])).toThrow(/supported runtime/)
  expect(() => windowsRocmPackages(backend, [{ vendor: 'AMD', vulkan_info: { device_id: 0xffff } }])).toThrow(
    /GPU architecture/
  )
})
