import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeTmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import { recordingIo } from '../io.js'
import { daemonCommand } from './daemon.js'

let data: TmpDataFolder

beforeEach(async () => {
  data = await makeTmpDataFolder('atomic-core-cli-')
})
afterEach(async () => {
  await data.cleanup()
})

const io = () => recordingIo()
const folder = () => ['--data-folder', data.root]

describe('daemon and serve compatibility', () => {
  it('starts an optional public listener from daemon flags before shutting down cleanly', async () => {
    const out = io()
    expect(
      await daemonCommand(
        [
          ...folder(),
          '--control-host',
          '127.0.0.1',
          '--control-port',
          '0',
          '--public-host',
          '127.0.0.1',
          '--public-port',
          '0',
          '--api-key',
          'k',
          '--verbose',
        ],
        out
      )
    ).toBe(0)
    expect(JSON.parse(out.out[0] as string)).toMatchObject({ event: 'core:ready' })
    expect(out.err.join('')).toContain('public API')
  })

  it('accepts the tunnel binary the app names, and still refuses a flag it does not know', async () => {
    const out = io()
    expect(
      await daemonCommand([...folder(), '--control-port', '0', '--cloudflared-bin', './bin/cloudflared'], out)
    ).toBe(0)
    expect(JSON.parse(out.out[0] as string)).toMatchObject({ event: 'core:ready' })
    await expect(daemonCommand([...folder(), '--cloudflared', './bin/cloudflared'], io())).rejects.toThrow(
      /--cloudflared/
    )
  })
})
