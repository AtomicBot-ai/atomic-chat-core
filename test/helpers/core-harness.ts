/**
 * A real `AtomicCore` over a throwaway data folder, shared by the facade's tests in `src/core/`. Each
 * test file calls `useCoreHarness()` once: every test gets a fresh `data` folder, and every core
 * created through `createCore()` (or pushed onto `cores`) is shut down afterwards.
 */
import { afterEach, beforeEach, expect } from 'vitest'
import type { SystemInfo } from '../../src/contracts/index.js'
import { AtomicCore } from '../../src/core/index.js'
import type { AtomicCoreOptions } from '../../src/core/index.js'
import { osTypeOf, rustArch } from '../../src/hardware/index.js'
import { makeTmpDataFolder } from './tmp-data-folder.js'
import type { TmpDataFolder } from './tmp-data-folder.js'

export let data: TmpDataFolder
export const cores: AtomicCore[] = []

export function useCoreHarness(): void {
  beforeEach(async () => {
    data = await makeTmpDataFolder('atomic-core-facade-')
  })
  afterEach(async () => {
    await Promise.all(cores.splice(0).map((c) => c.shutdown()))
    await data.cleanup()
  })
}

/**
 * What the harness core "measures": this host's OS and arch, flags unknown, no GPUs — so a facade test
 * never spawns `nvidia-smi` or PowerShell, and the CPU preflight stays silent unless a test injects flags.
 */
export const HARNESS_PROBE_INFO: SystemInfo = {
  cpu: {
    name: 'Harness CPU',
    core_count: 4,
    arch: rustArch(process.arch),
    extensions: [],
    extensions_known: false,
  },
  os_type: osTypeOf(process.platform),
  os_name: 'Harness OS',
  total_memory: 16_384,
  gpus: [],
}

export async function createCore(over: Partial<AtomicCoreOptions> = {}): Promise<AtomicCore> {
  const core = await AtomicCore.create({
    dataFolder: data.root,
    controlPort: 0,
    hardware: { probe: async () => ({ info: structuredClone(HARNESS_PROBE_INFO), warnings: [] }) },
    ...over,
  })
  cores.push(core)
  return core
}

export async function putHardwareOverride(core: AtomicCore, body: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${core.control.url}/atomic/v1/hardware/override`, {
    method: 'PUT',
    headers: {
      'authorization': `Bearer ${core.controlToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  expect(response.status).toBe(200)
}

export async function createOnPort(port: number): Promise<{ close: () => Promise<void> }> {
  const { createServer } = await import('node:http')
  const server = createServer((_req, res) => res.end('busy'))
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r))
  return {
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections?.()
        server.close(() => r())
      }),
  }
}
