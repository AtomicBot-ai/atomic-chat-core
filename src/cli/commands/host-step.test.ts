import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  INSTALL_CONTAINER_RUNTIME_RECIPE_DIGEST,
  installContainerRuntimeParametersDigest,
} from '../../host/recipes/index.js'
import type { HostStepExecutorDeps, HostStepResult } from '../../host/recipes/index.js'
import { recordingIo } from '../io.js'
import { runCli } from '../main.js'
import { hostStepCommand } from './host-step.js'

const parameters = {
  user: 'alice',
  arch: 'x86_64' as const,
  family: 'apt' as const,
  distro_id: 'ubuntu',
  version_id: '24.04',
  components: ['docker-group' as const],
}
const request = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    schema_version: 1,
    step_id: 'step-7',
    operation_id: 'op-1',
    action: 'linux.install-container-runtime',
    recipe_id: 'linux.install-container-runtime',
    recipe_digest: INSTALL_CONTAINER_RUNTIME_RECIPE_DIGEST,
    parameters_digest: installContainerRuntimeParametersDigest(parameters),
    nonce: 'nonce-7',
    expected_operation_revision: 2,
    data_folder: '/d',
    parameters,
    ...over,
  })

/** A machine where alice exists and `usermod` works; nothing real runs. */
function fakeDeps(text: string) {
  const written: Record<string, string> = {}
  const commands: string[] = []
  const deps: HostStepExecutorDeps = {
    readRequest: async () => text,
    writeResult: async (path, body) => {
      written[path] = body
    },
    readFile: async () => null,
    writeFile: async () => {},
    exec: async (argv) => {
      commands.push(argv.join(' '))
      if (argv[0] === 'id') return { code: 0, stdout: argv[1] === '-u' ? '1000\n' : 'alice\n', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    },
    fetch: (() => Promise.reject(new Error('no network in tests'))) as typeof fetch,
    now: () => 5,
    invokingUid: '1000',
  }
  return { deps, written, commands }
}

describe('host-step exec', () => {
  it('runs the request and writes the result beside it; exit 0 when completed', async () => {
    const io = recordingIo()
    const fake = fakeDeps(request())
    expect(await hostStepCommand(['exec', '/x/step-7.request.json'], io, fake.deps)).toBe(0)
    expect(fake.commands).toContain('usermod -aG docker alice')
    const result = JSON.parse(fake.written['/x/step-7.result.json']!) as HostStepResult
    expect(result).toMatchObject({ step_id: 'step-7', outcome: 'completed', nonce: 'nonce-7' })
    expect(io.out.join('')).toContain('step-7: completed')
  })

  it('exit 1 and the reason when the request is refused', async () => {
    const io = recordingIo()
    const fake = fakeDeps(request({ recipe_digest: `sha256:${'f'.repeat(64)}` }))
    expect(await hostStepCommand(['exec', '/x/step-7.request.json', '--json'], io, fake.deps)).toBe(1)
    expect(fake.commands).toEqual([])
    const printed = JSON.parse(io.out.join('')) as HostStepResult
    expect(printed).toMatchObject({ outcome: 'failed', error_code: 'MANAGED_HOST_STEP_INVALID' })
  })

  it.each<[string[], RegExp]>([
    [[], /Usage: atomic-chat-core host-step exec/],
    [['exec'], /Usage: atomic-chat-core host-step exec/],
    [['run', '/x/a.request.json'], /Unknown host-step subcommand: run/],
    [['exec', '/x/a.json'], /must be named <step_id>\.request\.json/],
  ])('%j is a usage error (exit 2)', async (argv, message) => {
    const io = recordingIo()
    expect(await hostStepCommand(argv, io, fakeDeps(request()).deps)).toBe(2)
    expect(io.err.join('')).toMatch(message)
  })
})

describe('the core binary routes host-step to the real executor', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'atomic-host-step-cli-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('a garbage request is refused with a result file, before any command could run', async () => {
    const path = join(dir, 'step-9.request.json')
    await writeFile(path, 'not json at all')
    // As under pkexec: the invoking user owns the folder and the request.
    const io = recordingIo({ env: { PKEXEC_UID: String(process.getuid?.() ?? 0) } })
    expect(await runCli(['host-step', 'exec', path], io)).toBe(1)
    const result = JSON.parse(await readFile(join(dir, 'step-9.result.json'), 'utf8')) as HostStepResult
    expect(result).toMatchObject({ outcome: 'failed', error_code: 'MANAGED_HOST_STEP_INVALID', steps: [] })
    expect(result.log_tail).toContain('not valid JSON')
  })

  // Meaningless when the suite itself runs as root: then the folder is root's own.
  it.skipIf(process.getuid?.() === 0)(
    'run as root directly, a folder a user owns is not trusted: no result is written there (exit 2)',
    async () => {
      const path = join(dir, 'step-9.request.json')
      await writeFile(path, '{}')
      const io = recordingIo({ env: {} })
      expect(await runCli(['host-step', 'exec', path], io)).toBe(2)
      expect(io.err.join('')).toMatch(/owned by uid/)
      await expect(readFile(join(dir, 'step-9.result.json'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      })
    }
  )
})
