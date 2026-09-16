import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CAN_INSTALL_FAKE_BACKEND, installFakeBackend } from '../../test/helpers/fake-backend-pack.js'
import { makeTmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import { AtomicCore } from '../core.js'
import { AGENTS, findAgent } from '../integrations/index.js'
import type { AgentDetection } from '../integrations/index.js'
import { recordingIo } from './io.js'
import { agentEnvironment, launchCommand, runAgent, runCommand, splitAgentArgs } from './launch.js'
import type { LaunchDeps, RunSpec } from './launch.js'

let data: TmpDataFolder
const cores: AtomicCore[] = []

beforeEach(async () => {
  data = await makeTmpDataFolder('atomic-core-launch-')
})
afterEach(async () => {
  await Promise.all(cores.splice(0).map((c) => c.shutdown()))
  await data.cleanup()
})

/** Pretend every agent is installed unless the test says otherwise. */
const detecting =
  (installed: (id: string) => boolean = () => true): LaunchDeps['detect'] =>
  async (agents) =>
    new Map<string, AgentDetection>(
      agents.map((a) => [
        a.id,
        installed(a.id)
          ? { installed: true, path: undefined, program: a.detectBin }
          : { installed: false, path: undefined, program: a.detectBin },
      ])
    )

describe('launch --list', () => {
  it('prints every agent with an installed marker', async () => {
    const io = recordingIo()
    expect(await launchCommand(['--list'], io, { detect: detecting((id) => id === 'codex') })).toBe(0)
    const text = io.out.join('')
    expect(text).toContain('Agents this CLI can configure')
    expect(text).toContain('● codex')
    expect(text).toContain('○ droid')
    expect(text).toContain('● installed   ○ not found on PATH')
    for (const agent of AGENTS) expect(text).toContain(agent.id)
  })

  it('prints the machine-readable catalog with --json', async () => {
    const io = recordingIo()
    expect(await launchCommand(['--list', '--json'], io, { detect: detecting(() => false) })).toBe(0)
    const parsed = JSON.parse(io.out.join('')) as Array<Record<string, unknown>>
    expect(parsed).toHaveLength(AGENTS.length)
    expect(parsed[0]).toMatchObject({ id: 'kilo', bin: 'kilo', installed: false, path: null })
    const claude = parsed.find((a) => a['id'] === 'claude-code')
    expect(claude).toMatchObject({ endpoint_with_prefix: false, requires_model: false })
    const zed = parsed.find((a) => a['id'] === 'zed')
    expect(zed).toMatchObject({ run_mode: 'gui' })
    const goose = parsed.find((a) => a['id'] === 'goose')
    expect(goose).toMatchObject({ run_args: ['session'] })
  })
})

describe('refusals', () => {
  it('rejects an unknown agent and shows the catalog', async () => {
    const io = recordingIo()
    expect(await launchCommand(['nope'], io, { detect: detecting() })).toBe(1)
    expect(io.err.join('')).toContain("unknown agent 'nope'")
    expect(io.out.join('')).toContain('Agents this CLI can configure')
  })

  it('explains why Muse Code cannot be launched from the CLI', async () => {
    const io = recordingIo()
    expect(await launchCommand(['muse'], io, { detect: detecting() })).toBe(1)
    const text = io.err.join('')
    expect(text).toContain('Muse Code cannot be launched from the CLI')
    expect(text).toContain('/muse-code/models')
    expect(text).toContain('Integrations')
  })

  it('points at the docs when the agent is not installed', async () => {
    const io = recordingIo()
    expect(await launchCommand(['codex'], io, { detect: detecting(() => false) })).toBe(1)
    const text = io.err.join('')
    expect(text).toContain('Codex CLI is not installed')
    expect(text).toContain('https://github.com/openai/codex')
  })

  it('requires standalone to use an explicit isolated data folder', async () => {
    await expect(
      launchCommand(['codex', '--standalone', '--model', 'demo'], recordingIo(), {
        detect: detecting(),
      })
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })
})

describe('agentEnvironment', () => {
  it('drops ambient provider credentials and adds what the agent reads', () => {
    const base = { PATH: '/bin', OPENAI_API_KEY: 'leaked', ANTHROPIC_API_KEY: 'leaked', HOME: '/home/u' }
    const env = agentEnvironment(base, findAgent('goose') as never, 'http://127.0.0.1:6767', 'm', 'k')
    expect(env['OPENAI_API_KEY'], 'goose gets its own value, not the ambient one').toBe('k')
    expect(env['ANTHROPIC_API_KEY']).toBeUndefined()
    expect(env['PATH']).toBe('/bin')
    expect(env['GOOSE_MODEL']).toBe('m')

    const codexEnv = agentEnvironment(base, findAgent('codex') as never, 'http://h/v1', 'm', 'k')
    expect(codexEnv['OPENAI_API_KEY']).toBeUndefined()
    expect(codexEnv['HOME']).toBe('/home/u')
  })
})

describe.skipIf(!CAN_INSTALL_FAKE_BACKEND)('launching an agent', () => {
  async function runningCore(): Promise<AtomicCore> {
    const core = await AtomicCore.create({ dataFolder: data.root, controlPort: 0 })
    cores.push(core)
    return core
  }

  it('loads the model, configures the agent, runs it and unloads afterwards', async () => {
    const core = await runningCore()
    await data.writeModel('demo')
    await installFakeBackend(data.layout)
    const configured: Array<{ agent: string; apiUrl: string; model: string; apiKey: string }> = []
    const ran: RunSpec[] = []
    const io = recordingIo()

    const code = await launchCommand(
      ['codex', '--model', 'demo', '--port', '0', '--data-folder', data.root],
      io,
      {
        detect: detecting(),
        configure: async (agent, apiUrl, model, apiKey) => {
          configured.push({ agent: agent.id, apiUrl, model, apiKey })
        },
        run: async (spec) => {
          ran.push(spec)
          return 0
        },
      }
    )

    expect(code).toBe(0)
    expect(configured).toHaveLength(1)
    expect(configured[0]).toMatchObject({ agent: 'codex', model: 'demo', apiKey: 'atomic' })
    expect(configured[0]?.apiUrl, 'Codex wants the /v1 prefix').toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/)
    expect(ran[0]).toMatchObject({ program: 'codex', args: [], detached: false })
    expect(core.sessions(), 'the model is unloaded when the agent exits').toEqual([])
    expect(io.err.join('')).toContain('Agent     Codex CLI')
  })

  it('uses the production agent config writer when none is injected', async () => {
    await runningCore()
    await data.writeModel('demo')
    await installFakeBackend(data.layout)
    const io = recordingIo({ env: { HOME: data.root } })
    expect(
      await launchCommand(['codex', '--model', 'demo', '--port', '0', '--data-folder', data.root], io, {
        detect: detecting(),
        run: async () => 0,
      })
    ).toBe(0)
    expect(await readFile(join(data.root, '.codex/config.toml'), 'utf8')).toContain(
      '[model_providers.atomic]'
    )
  })

  it('runs standalone as a foreground owner and shuts it down with its session', async () => {
    await data.writeModel('demo')
    await installFakeBackend(data.layout)
    expect(
      await launchCommand(
        ['codex', '--standalone', '--model', 'demo', '--port', '0', '--data-folder', data.root],
        recordingIo(),
        { detect: detecting(), configure: async () => {}, run: async () => 0 }
      )
    ).toBe(0)
    await expect(readFile(data.layout.core.instanceLock, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('passes the agent its own arguments after the ones the catalog requires', async () => {
    await runningCore()
    await data.writeModel('demo')
    await installFakeBackend(data.layout)
    const ran: RunSpec[] = []
    const code = await launchCommand(
      ['goose', '--model', 'demo', '--port', '0', '--data-folder', data.root, '--debug'],
      recordingIo(),
      { detect: detecting(), configure: async () => {}, run: async (s) => (ran.push(s), 7) }
    )
    expect(code, 'the agent’s exit code is ours').toBe(7)
    expect(ran[0]?.args).toEqual(['session', '--debug'])
    expect(ran[0]?.env['GOOSE_PROVIDER']).toBe('openai')
    expect(ran[0]?.env['OPENAI_HOST'], 'Goose appends its own path').toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  })

  it('keeps serving after a GUI agent opens, until it is interrupted', async () => {
    const core = await runningCore()
    await data.writeModel('demo')
    await installFakeBackend(data.layout)
    let stop: (() => void) | undefined
    const io = recordingIo({
      waitForShutdown: (onStop) =>
        new Promise<void>((resolve) => {
          stop = () => void onStop().then(resolve)
        }),
    })
    const ran: RunSpec[] = []
    const launching = launchCommand(
      ['zed', '--model', 'demo', '--port', '0', '--data-folder', data.root],
      io,
      {
        detect: detecting(),
        configure: async () => {},
        run: async (s) => (ran.push(s), 0),
      }
    )
    await waitFor(() => stop !== undefined)
    expect(ran[0]?.detached, 'a GUI launcher must not hold the terminal').toBe(true)
    expect(core.sessions(), 'the model stays loaded while the window is open').toHaveLength(1)
    stop?.()
    expect(await launching).toBe(0)
    expect(core.sessions()).toEqual([])
  })

  it('unloads the model when the agent config could not be written', async () => {
    const core = await runningCore()
    await data.writeModel('demo')
    await installFakeBackend(data.layout)
    await expect(
      launchCommand(['codex', '--model', 'demo', '--port', '0', '--data-folder', data.root], recordingIo(), {
        detect: detecting(),
        configure: async () => {
          throw new Error('disk is full')
        },
        run: async () => 0,
      })
    ).rejects.toMatchObject({ code: 'IO_ERROR', details: 'disk is full' })
    expect(core.sessions()).toEqual([])
  })

  it('refuses to guess a model when none is installed', async () => {
    await runningCore()
    await expect(
      launchCommand(['codex', '--data-folder', data.root], recordingIo(), {
        detect: detecting(),
        configure: async () => {},
        run: async () => 0,
      })
    ).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND' })
  })
})

describe('splitAgentArgs', () => {
  it('keeps our flags and forwards the agent’s', () => {
    expect(splitAgentArgs(['goose', '--model', 'demo', '--debug'])).toEqual({
      own: ['goose', '--model', 'demo'],
      forwarded: ['--debug'],
    })
    expect(splitAgentArgs(['--list', '--json'])).toEqual({ own: ['--list', '--json'], forwarded: [] })
    expect(splitAgentArgs(['codex', 'exec', 'do', 'something'])).toEqual({
      own: ['codex'],
      forwarded: ['exec', 'do', 'something'],
    })
    expect(splitAgentArgs(['claude', '--', '--model', 'theirs'])).toEqual({
      own: ['claude'],
      forwarded: ['--model', 'theirs'],
    })
    expect(splitAgentArgs(['--data-folder', '/d', 'zed', '--foo', 'bar'])).toEqual({
      own: ['--data-folder', '/d', 'zed'],
      forwarded: ['--foo', 'bar'],
    })
    expect(splitAgentArgs(['claude', '--fit=false'])).toEqual({
      own: ['claude', '--no-fit'],
      forwarded: [],
    })
  })
})

describe('process runners', () => {
  it('returns a terminal process exit code and reports spawn failures', async () => {
    await expect(
      runAgent({
        program: process.execPath,
        args: ['-e', 'process.exit(7)'],
        env: process.env,
        detached: false,
      })
    ).resolves.toBe(7)
    await expect(
      runAgent({ program: '/definitely/missing/atomic-agent', args: [], env: {}, detached: false })
    ).rejects.toMatchObject({ code: 'IO_ERROR' })
  })

  it('captures command output, numeric failure codes and missing executables', async () => {
    await expect(runCommand(process.execPath, ['-e', 'process.stdout.write("ok")'])).resolves.toEqual({
      code: 0,
      stdout: 'ok',
      stderr: '',
    })
    await expect(
      runCommand(process.execPath, ['-e', 'process.stderr.write("bad"); process.exit(3)'])
    ).resolves.toMatchObject({ code: 3, stderr: 'bad' })
    await expect(runCommand('/definitely/missing/setx', [])).rejects.toBeTruthy()
  })
})

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 20))
  }
}
