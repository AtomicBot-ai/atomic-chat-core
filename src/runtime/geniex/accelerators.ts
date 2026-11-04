/**
 * GenieX's devices as accelerators (openspec change `add-geniex-runtime`, task 6.4, design D3): what
 * the active build's library found at its install — the Hexagon NPU (`HTP0`) and the Adreno GPU
 * (`GPUOpenCL`) — in LiteRT-LM's shape, so the clients reuse their UI. Everything a device needs
 * ships inside the SDK build, so each is `prepared` the moment it is listed and `prepare` has
 * nothing to download; it answers so without an event.
 */

import type {
  GeniexAccelerators,
  GeniexChip,
  GeniexPrepareRequest,
  GeniexPrepareResult,
} from '../../contracts/index.js'
import { acceleratorsFound } from './devices.js'
import type { GeniexBuild } from './runtime.js'

export interface GeniexAcceleratorDeps {
  resolveBuild: () => Promise<GeniexBuild | undefined>
  chip: GeniexChip
}

const NOTHING_TO_PREPARE =
  "Nothing to prepare: GenieX's NPU and GPU libraries are part of the installed build."

export class GeniexAcceleratorService {
  constructor(private readonly deps: GeniexAcceleratorDeps) {}

  async list(): Promise<GeniexAccelerators> {
    const build = await this.deps.resolveBuild()
    if (!build) return { installed: false, build: null, chip: this.deps.chip, accelerators: [], error: null }
    return {
      installed: true,
      build: `${build.version}/${build.dir.split(/[\\/]/).at(-1) ?? ''}`,
      chip: this.deps.chip,
      accelerators: acceleratorsFound(build.devices).map((device) => ({
        name: device,
        device,
        version: build.version,
        size_bytes: 0,
        prepared: true,
      })),
      error: null,
    }
  }

  /** Every name answers at once: prepared when the library found it, with why it is not otherwise. */
  async prepare(request: GeniexPrepareRequest): Promise<GeniexPrepareResult> {
    const listed = await this.list()
    const offered = new Set(listed.accelerators.map((accelerator) => accelerator.name))
    const wanted =
      request.accelerators && request.accelerators.length > 0 ? request.accelerators : [...offered]
    return {
      accelerators: wanted.map((name) =>
        offered.has(name)
          ? { name, prepared: true, reason: NOTHING_TO_PREPARE }
          : {
              name,
              prepared: false,
              reason: !listed.installed
                ? 'GenieX is not installed on this computer.'
                : name === 'npu' || name === 'gpu'
                  ? `GenieX found no ${name.toUpperCase()} on this computer.`
                  : `GenieX has no ${name} accelerator.`,
            }
      ),
    }
  }
}
