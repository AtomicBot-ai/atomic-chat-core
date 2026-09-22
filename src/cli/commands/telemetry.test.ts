import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeTmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import { recordingIo } from '../io.js'
import { printFirstRunNotice, telemetryCommand } from './telemetry.js'

let data: TmpDataFolder

beforeEach(async () => {
  data = await makeTmpDataFolder('atomic-core-cli-telemetry-')
})
afterEach(async () => {
  await data.cleanup()
})

const run = async (args: string[], env: NodeJS.ProcessEnv = {}) => {
  const io = recordingIo({ env })
  const code = await telemetryCommand([...args, '--data-folder', data.root], io)
  return { code, out: io.out.join(''), err: io.err.join('') }
}

describe('telemetry', () => {
  it('is on by default and says how to turn it off', async () => {
    expect(await run([])).toEqual({
      code: 0,
      out: 'Error reports: on (the default; turn off with `atomic-chat-core telemetry off`)\n',
      err: '',
    })
  })

  it('stores the choice in the data folder and reads it back', async () => {
    const off = await run(['off'])
    expect(off.out).toBe(
      'Error reports: off (your choice)\nA core that is already running keeps its setting until it restarts.\n'
    )
    expect(JSON.parse(await readFile(data.layout.core.telemetry, 'utf8'))).toEqual({
      enabled: false,
      notice_shown: true,
    })
    expect((await run(['status'])).out).toBe('Error reports: off (your choice)\n')
    expect((await run(['on'])).out).toContain('Error reports: on (your choice)')
  })

  it('lets DO_NOT_TRACK win', async () => {
    await run(['on'])
    expect((await run(['status'], { DO_NOT_TRACK: '1' })).out).toBe(
      'Error reports: off (set by DO_NOT_TRACK or ATOMIC_CORE_TELEMETRY)\n'
    )
  })

  it('refuses an unknown action, and fails loudly when it cannot save', async () => {
    expect(await run(['maybe'])).toMatchObject({
      code: 2,
      err: 'Unknown telemetry action "maybe": use status, on or off.\n',
    })
    const blocker = join(data.root, 'blocker')
    await writeFile(blocker, 'x')
    await expect(
      telemetryCommand(['off', '--data-folder', join(blocker, 'data')], recordingIo())
    ).rejects.toMatchObject({ code: 'IO_ERROR' })
  })
})

describe('printFirstRunNotice', () => {
  it('prints once per data folder when reports would go out by default', async () => {
    const env = { ATOMIC_CORE_SENTRY_DSN: 'http://k@127.0.0.1:9/1' }
    const first = recordingIo({ env })
    await printFirstRunNotice(first, data.layout.core.telemetry)
    expect(first.err.join('')).toContain('`atomic-chat-core telemetry off` or DO_NOT_TRACK=1')
    const second = recordingIo({ env })
    await printFirstRunNotice(second, data.layout.core.telemetry)
    expect(second.err).toEqual([])
  })
})
