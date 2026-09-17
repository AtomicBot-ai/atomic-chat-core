import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeTmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import { AtomicCore } from '../../core/index.js'
import { recordingIo } from '../io.js'
import { shutdownCommand } from './shutdown.js'

let data: TmpDataFolder

beforeEach(async () => {
  data = await makeTmpDataFolder('atomic-core-cli-')
})
afterEach(async () => {
  await data.cleanup()
})

const io = () => recordingIo()
const folder = () => ['--data-folder', data.root]

describe('shutdown', () => {
  it('stops a running core and is a no-op when none is running', async () => {
    const core = await AtomicCore.create({ dataFolder: data.root, controlPort: 0 })
    const out = io()
    expect(await shutdownCommand(folder(), out)).toBe(0)
    expect(out.out.join('')).toContain('Core is stopping')
    await waitFor(async () =>
      (await import('../../lock/index.js')).inspectLock(data.layout).then((s) => s.kind === 'free')
    )
    void core

    const second = io()
    expect(await shutdownCommand(folder(), second)).toBe(0)
    expect(second.out.join('')).toContain('No core is running')
  })
})

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 25))
  }
}
