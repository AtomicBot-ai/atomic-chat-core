import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeTmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import { AtomicCore } from '../../core/index.js'
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

  it('passes a start-up failure on after reporting it, and names a host consent it cannot read', async () => {
    const owner = await AtomicCore.create({ dataFolder: data.root, ownerScope: 'cli', controlPort: 0 })
    try {
      await expect(
        daemonCommand([...folder(), '--control-port', '0', '--telemetry', 'off'], io())
      ).rejects.toMatchObject({
        code: 'CORE_ALREADY_RUNNING',
      })
    } finally {
      await owner.shutdown()
    }
    await expect(daemonCommand([...folder(), '--telemetry', 'maybe'], io())).rejects.toThrow(
      '--telemetry takes'
    )
  })

  it('reports a start-up failure, says so once, and mentions a report it could not send', async () => {
    const notAFolder = join(data.root, 'not-a-folder')
    await writeFile(notAFolder, 'x')
    const out = recordingIo({ env: { ATOMIC_CORE_SENTRY_DSN: 'http://k@127.0.0.1:9/1' } })
    await expect(
      daemonCommand(['--data-folder', notAFolder, '--control-port', '0'], out)
    ).rejects.toMatchObject({
      code: 'ENOTDIR',
    })
    const stderr = out.err.join('')
    expect(stderr).toContain('`atomic-chat-core telemetry off` or DO_NOT_TRACK=1')
    expect(stderr).toContain('[warn] error report not sent')
  })
})
