/**
 * GenieX's device ids and the devices a model names (openspec change `add-geniex-runtime`, design
 * D3): `geniex_get_device_list` of the `llama_cpp` plugin answers ids such as `HTP0` (the Hexagon
 * NPU), `GPUOpenCL` (the Adreno GPU) and `CPU`; a model asks for `npu`, `gpu`, `cpu` or `hybrid`
 * (NPU and GPU together). The ids are what `probe` recorded at the build's install.
 */

import type { GeniexDevice } from '../../contracts/index.js'

const hasNpu = (ids: readonly string[]): boolean => ids.some((id) => /^HTP/i.test(id))
const hasGpu = (ids: readonly string[]): boolean => ids.some((id) => /^GPU/i.test(id))

/** Whether the library found what `device` needs; the CPU is always there. */
export function deviceFound(device: GeniexDevice, ids: readonly string[]): boolean {
  switch (device) {
    case 'npu':
      return hasNpu(ids)
    case 'gpu':
      return hasGpu(ids)
    case 'hybrid':
      return hasNpu(ids) && hasGpu(ids)
    case 'cpu':
      return true
  }
}

/** Why `device` is not there, in words a card can show. */
export function deviceMissingReason(device: GeniexDevice): string {
  if (device === 'gpu') return 'GenieX found no Adreno GPU (no OpenCL device) on this computer.'
  return `GenieX found no Hexagon NPU (no HTP device) on this computer${device === 'hybrid' ? ', which hybrid needs with the GPU' : ''}; check the Qualcomm NPU driver.`
}

/** The accelerators the library found, in the order the clients list them: the NPU, then the GPU. */
export function acceleratorsFound(ids: readonly string[]): Array<Extract<GeniexDevice, 'npu' | 'gpu'>> {
  return [...(hasNpu(ids) ? ['npu' as const] : []), ...(hasGpu(ids) ? ['gpu' as const] : [])]
}
