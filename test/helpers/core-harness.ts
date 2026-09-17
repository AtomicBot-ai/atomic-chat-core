/**
 * A real `AtomicCore` over a throwaway data folder, shared by the facade's tests in `src/core/`. Each
 * test file calls `useCoreHarness()` once: every test gets a fresh `data` folder, and every core
 * created through `createCore()` (or pushed onto `cores`) is shut down afterwards.
 */
import { afterEach, beforeEach, expect } from 'vitest'
import { AtomicCore } from '../../src/core/index.js'
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

export async function createCore(): Promise<AtomicCore> {
  const core = await AtomicCore.create({ dataFolder: data.root, controlPort: 0 })
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
