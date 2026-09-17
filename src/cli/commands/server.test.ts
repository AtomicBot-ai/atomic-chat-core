import { writeFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeTmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import { AtomicCore } from '../../core/index.js'
import { recordingIo } from '../io.js'
import { serverCommand } from './server.js'

let data: TmpDataFolder
const cores: AtomicCore[] = []

beforeEach(async () => {
  data = await makeTmpDataFolder('atomic-core-cli-')
})
afterEach(async () => {
  await Promise.all(cores.splice(0).map((c) => c.shutdown()))
  await data.cleanup()
})

const io = () => recordingIo()
const folder = () => ['--data-folder', data.root]

describe('server status', () => {
  it('reports a running core server and lists its models', async () => {
    const core = await AtomicCore.create({ dataFolder: data.root, controlPort: 0 })
    cores.push(core)
    const state = await core.startPublicServer({ port: 0 })
    const out = io()
    expect(await serverCommand(['status', ...folder()], out)).toBe(0)
    const text = out.out.join('')
    expect(text).toContain('Local API Server is running')
    expect(text).toContain(`127.0.0.1:${state.port}/v1`)
    expect(text).toContain('none loaded')
  })

  it('exits 1 when nothing answers, and says where it looked', async () => {
    const out = io()
    expect(await serverCommand(['status', ...folder(), '--port', '1'], out)).toBe(1)
    expect(out.out.join('')).toContain('No Local API Server at http://127.0.0.1:1/v1')
  })

  it("prefers the core's published state over the app's state file", async () => {
    await writeFile(
      data.layout.core.publicServerState,
      JSON.stringify({
        running: true,
        host: '127.0.0.1',
        port: 5555,
        prefix: '/v1',
        requires_api_key: false,
        pid: 7,
      })
    )
    await writeFile(
      data.layout.serverStateFile,
      JSON.stringify({
        running: true,
        host: '127.0.0.1',
        port: 4321,
        prefix: '/v1',
        requires_api_key: false,
        pid: 5,
      })
    )
    const out = io()
    expect(await serverCommand(['status', '--json', ...folder()], out)).toBe(1)
    expect(JSON.parse(out.out.join(''))).toMatchObject({ url: 'http://127.0.0.1:5555/v1' })
  })

  it('falls back to the app state file when no core is running', async () => {
    await writeFile(
      data.layout.serverStateFile,
      JSON.stringify({
        running: true,
        host: '0.0.0.0',
        port: 4321,
        prefix: '/v1',
        requires_api_key: true,
        pid: 5,
      })
    )
    const out = io()
    expect(await serverCommand(['status', '--json', ...folder()], out)).toBe(1)
    expect(JSON.parse(out.out.join(''))).toMatchObject({
      running: false,
      url: 'http://127.0.0.1:4321/v1',
      requires_api_key: true,
      models: null,
      models_error: 'server not reachable',
    })
  })

  it('rejects an unknown subcommand', async () => {
    const out = io()
    expect(await serverCommand(['restart', ...folder()], out)).toBe(2)
  })
})
