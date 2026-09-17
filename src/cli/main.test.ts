import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CAN_INSTALL_FAKE_BACKEND, installFakeBackend } from '../../test/helpers/fake-backend-pack.js'
import { makeTmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import { CORE_VERSION } from '../version.js'
import { recordingIo } from './io.js'
import { runCli, USAGE } from './main.js'

const run = async (argv: string[]) => {
  const io = recordingIo()
  const exitCode = await runCli(argv, io)
  return { exitCode, stdout: io.out.join(''), stderr: io.err.join('') }
}

describe('runCli', () => {
  it('prints the version and exits 0', async () => {
    expect(await run(['--version'])).toMatchObject({ exitCode: 0, stdout: `${CORE_VERSION}\n` })
    expect(await run(['-v'])).toMatchObject({ exitCode: 0 })
  })

  it('leaves command-local -v for serve instead of treating it as --version', async () => {
    const result = await run(['serve', '-v', '--data-folder', '/definitely/empty'])
    expect(result.stdout).not.toBe(`${CORE_VERSION}\n`)
    expect(result.stderr).toContain('No chat models are installed')
  })

  it('prints usage: 0 when asked, 2 when given nothing', async () => {
    expect(await run(['--help'])).toMatchObject({ exitCode: 0, stdout: USAGE })
    expect(await run([])).toMatchObject({ exitCode: 2, stdout: USAGE })
  })

  it('names every phase-1 command in the help text', () => {
    for (const command of ['serve', 'models list', 'server status', 'daemon', 'shutdown']) {
      expect(USAGE).toContain(command)
    }
    expect(USAGE, 'the detach difference from jan-cli must be stated').toContain('Ctrl+C detaches')
  })

  it('rejects an unknown command with usage on stderr', async () => {
    const result = await run(['nope'])
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('Unknown command: nope')
    expect(result.stderr).toContain('Usage:')
  })

  it('dispatches providers and auth, which explain themselves when called without an action', async () => {
    expect((await run(['providers'])).exitCode).toBe(2)
    const auth = await run(['auth', 'nothing'])
    expect(auth.exitCode).toBe(2)
    expect(auth.stderr).toContain('auth chatgpt status | login | logout | models')
  })

  it('turns a core error into one readable line with its code', async () => {
    const result = await run(['shutdown', '--data-folder', '/definitely/not/a/folder'])
    expect(result.exitCode).toBe(0) // no core there is not a failure
    expect(result.stdout).toContain('No core is running')
  })

  it('reports a bad flag as an error, not a crash', async () => {
    const result = await run(['models', 'list', '--nonsense'])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('Error:')
  })

  it('formats structured core errors and non-Error throws', async () => {
    const data = await makeTmpDataFolder('atomic-core-main-errors-')
    const core = await (
      await import('../core.js')
    ).AtomicCore.create({
      dataFolder: data.root,
      controlPort: 0,
    })
    try {
      await data.writeModel('local')
      const structured = recordingIo()
      expect(await runCli(['serve', 'local', '--data-folder', data.root], structured)).toBe(1)
      expect(structured.err.join('')).toContain('[BINARY_NOT_FOUND]')

      const thrown = recordingIo({ fetch: async () => Promise.reject('plain failure') })
      expect(await runCli(['serve', 'owner/repo', '--data-folder', data.root], thrown)).toBe(1)
      expect(thrown.err.join('')).toContain('plain failure')
    } finally {
      await core.shutdown()
      await data.cleanup()
    }
  })
})

describe('dispatch', () => {
  let data: TmpDataFolder
  beforeEach(async () => {
    data = await makeTmpDataFolder('atomic-core-dispatch-')
  })
  afterEach(() => data.cleanup())

  it('routes `models list` to the models command', async () => {
    await data.writeModel('demo')
    const io = recordingIo()
    expect(await runCli(['models', 'list', '--json', '--data-folder', data.root], io)).toBe(0)
    expect((JSON.parse(io.out.join('')) as Array<{ id: string }>).map((m) => m.id)).toEqual(['demo'])
  })

  it('routes `server status` and returns its exit code', async () => {
    const io = recordingIo()
    expect(await runCli(['server', 'status', '--data-folder', data.root, '--port', '1'], io)).toBe(1)
    expect(io.out.join('')).toContain('No Local API Server')
  })

  it('routes `serve` and reports an empty non-interactive model list', async () => {
    const io = recordingIo()
    expect(await runCli(['serve', '--data-folder', data.root], io)).toBe(1)
    expect(io.err.join('')).toContain('No chat models are installed')
  })

  it.skipIf(!CAN_INSTALL_FAKE_BACKEND)(
    'runs the whole daemon → serve → shutdown cycle in one process',
    async () => {
      await data.writeModel('demo')
      await installFakeBackend(data.layout)
      let stopDaemon: (() => void) | undefined
      const daemonIo = recordingIo({
        waitForShutdown: (onStop) =>
          new Promise<void>((resolve) => {
            stopDaemon = () => void onStop().then(resolve)
          }),
      })
      const daemon = runCli(['daemon', '--data-folder', data.root, '--control-port', '0'], daemonIo)
      await waitFor(() => daemonIo.out.length > 0)
      const ready = JSON.parse(daemonIo.out[0] as string) as { event: string; control_port: number }
      expect(ready.event).toBe('core:ready')
      expect(ready.control_port).toBeGreaterThan(0)

      const serveIo = recordingIo()
      expect(
        await runCli(
          [
            'serve',
            'demo',
            '--port',
            '0',
            '--timeout',
            '5',
            '--n-gpu-layers=-1',
            '--ctx-size',
            '4096',
            '--fit',
            '--threads',
            '2',
            '--api-key',
            'test-key',
            '--detach',
            '--verbose',
            '--json',
            '--data-folder',
            data.root,
          ],
          serveIo
        )
      ).toBe(0)
      const served = JSON.parse(serveIo.out.join('')) as {
        session: { model_id: string }
        server: { port: number; requires_api_key: boolean }
      }
      expect(served.session.model_id).toBe('demo')
      expect(served.server.requires_api_key).toBe(true)
      const { readFile } = await import('node:fs/promises')
      expect(await readFile(data.layout.core.logsDir + '/serve.log', 'utf8')).toMatch(/listening/i)

      const human = recordingIo()
      expect(
        await runCli(
          ['serve', 'demo', '--port', '0', '--api-key', 'test-key', '--data-folder', data.root],
          human
        )
      ).toBe(0)
      expect(human.out.join('')).toContain('is serving at')
      expect(human.out.join('')).toContain('clients must send the API key')

      await data.writeModel('other')
      const conflict = recordingIo()
      expect(
        await runCli(
          ['serve', 'other', '--port', '0', '--api-key', 'different-key', '--data-folder', data.root],
          conflict
        )
      ).toBe(1)
      expect(conflict.err.join('')).toContain('CORE_ALREADY_RUNNING')
      const publicModels = (await (
        await fetch(`http://127.0.0.1:${served.server.port}/v1/models`, {
          headers: { authorization: 'Bearer test-key' },
        })
      ).json()) as { data: Array<{ id: string }> }
      expect(publicModels.data.map((model) => model.id)).toEqual(['demo'])

      const shutdownIo = recordingIo()
      expect(await runCli(['shutdown', '--data-folder', data.root], shutdownIo)).toBe(0)
      expect(await daemon).toBe(0)
      expect(stopDaemon).toBeTypeOf('function')
    },
    30_000
  )
})

async function waitFor(predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 25))
  }
}
