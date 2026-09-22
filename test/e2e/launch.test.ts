/**
 * `launch <agent>` through the compiled binary (stage 7m for ZCode): the model loaded in the core
 * that owns the folder, the public listener claimed, the agent's own config file written the way
 * the agent reads it, the model kept until Ctrl+C and unloaded on the way out; and the refusal for
 * an agent that is not installed.
 *
 * ZCode is a desktop app that reads `<home>/.zcode/v2/provider_config.json`; the launcher here is
 * a script named `zcode` on a PATH of our own that returns at once, as the real one does.
 *
 * No imports from `src/`. POSIX only: the fake backend and the launcher are shell scripts.
 */
import type { ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as core from '../helpers/compiled-core.js'
import type { ReadyLine } from '../helpers/compiled-core.js'

const { BIN } = core

let dataFolder: string
let home: string
let binDir: string
const daemons: ChildProcess[] = []
const commands: Array<{ child: ChildProcess; exit: Promise<number | null> }> = []

beforeEach(async () => {
  dataFolder = await mkdtemp(join(tmpdir(), 'atomic-core-e2e-launch-'))
  home = join(dataFolder, 'home')
  binDir = join(dataFolder, 'bin')
  await mkdir(home, { recursive: true })
  await mkdir(binDir, { recursive: true })
})
afterEach(async () => {
  for (const command of commands.splice(0)) {
    command.child.kill('SIGKILL')
    await command.exit
  }
  for (const daemon of daemons.splice(0)) daemon.kill('SIGKILL')
  core.reapJournalledChildren(dataFolder)
  await rm(dataFolder, { recursive: true, force: true })
})

const control = (ready: ReadyLine, path: string, init: RequestInit = {}) =>
  core.control(dataFolder, ready, path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  })

/** The environment a user's shell would give the CLI: our PATH first, our home, no agent conflicts. */
const shellEnv = (): NodeJS.ProcessEnv => ({
  PATH: `${binDir}:${process.env['PATH'] ?? ''}`,
  HOME: home,
  ZCODE_DATA_BASE_DIR: '',
})

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

async function sessions(ready: ReadyLine): Promise<Array<{ model_id: string; pid: number }>> {
  return (
    (await (await control(ready, '/sessions')).json()) as {
      sessions: Array<{ model_id: string; pid: number }>
    }
  ).sessions
}

const providerFile = () => join(home, '.zcode', 'v2', 'provider_config.json')

interface ProviderConfig {
  schemaVersion: number
  config: {
    providerConfigRules: {
      providerRules: Array<{
        providerId: string
        enabled: boolean
        config: {
          api: { type: string; baseUrl: string }
          access: { apiKey: string }
          personalModelIds: string[]
        }
      }>
    }
    modelConfigRules: {
      providerModelRules: Array<{
        providerId: string
        modelId: string
        config: { properties: { contextWindow: number } }
      }>
    }
    defaultModelSelection: { providerId: string; modelId: string }
  }
}

describe.skipIf(!existsSync(BIN) || process.platform === 'win32')('launch through the compiled core', () => {
  it('launch zcode writes the provider file ZCode reads, keeps the model loaded until interrupted, and unloads it on the way out', async () => {
    // A ZCode that records it was opened and returns at once, like the real desktop app.
    const opened = join(dataFolder, 'zcode-opened.jsonl')
    await writeFile(
      join(binDir, 'zcode'),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(opened)}\nexit 0\n`
    )
    await chmod(join(binDir, 'zcode'), 0o755)
    // The user's own provider, which must survive untouched.
    await mkdir(join(home, '.zcode', 'v2'), { recursive: true })
    const theirs = {
      schemaVersion: 1,
      config: {
        providerConfigRules: {
          providerRules: [
            {
              providerId: 'their-provider',
              providerName: 'Theirs',
              enabled: true,
              config: {
                group: 'standard-personal',
                access: { type: 'api-key', apiKey: 'sk-theirs' },
                api: { type: 'openai-chat-completions', baseUrl: 'https://example.test/v1', headers: null },
                personalModelIds: ['their-model'],
                modelOrder: ['their-model'],
              },
            },
          ],
        },
        modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
      },
    }
    await writeFile(providerFile(), JSON.stringify(theirs, null, 2))

    await core.writeModel(dataFolder, 'demo')
    await core.writeFakeBackend(dataFolder)
    const { ready } = await core.startDaemon(dataFolder, daemons)

    const launch = core.spawnCli(
      dataFolder,
      ['launch', 'zcode', '--model', 'demo', '--port', '0'],
      shellEnv()
    )
    commands.push(launch)
    await waitFor(
      () => launch.output().includes('ZCode opened.'),
      `ZCode to be opened:\n${launch.output()}`,
      30_000
    )
    const endpoint = /Endpoint\s+(\S+)/.exec(launch.output())?.[1] as string
    expect(endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/)
    expect(launch.output()).toContain('Model     demo')
    // The launcher was run detached, with no arguments of ours.
    await waitFor(() => existsSync(opened), 'the ZCode launcher to have run')
    expect(readFileSync(opened, 'utf8')).toBe('\n')

    // The model is a session of the owner we started, served on the listener the endpoint names.
    expect(await sessions(ready)).toEqual([expect.objectContaining({ model_id: 'demo' })])
    const models = await fetch(`${endpoint}/models`, { headers: { authorization: 'Bearer atomic' } })
    expect(models.status).toBe(200)
    expect(JSON.stringify(await models.json())).toContain('demo')
    expect((await fetch(`${endpoint}/models`)).status).toBe(401)

    // The provider file: ours added, theirs kept, the model rule with the context window ZCode is told.
    const written = JSON.parse(readFileSync(providerFile(), 'utf8')) as ProviderConfig
    expect(written.schemaVersion).toBe(1)
    const rules = written.config.providerConfigRules.providerRules
    expect(rules.map((rule) => rule.providerId)).toEqual(['their-provider', 'atomic-chat'])
    expect(rules[0]).toMatchObject({ config: { access: { apiKey: 'sk-theirs' } } })
    expect(rules[1]).toMatchObject({
      enabled: true,
      config: {
        api: { type: 'openai-chat-completions', baseUrl: endpoint },
        access: { apiKey: 'atomic' },
        personalModelIds: ['demo'],
      },
    })
    expect(written.config.modelConfigRules.providerModelRules).toEqual([
      expect.objectContaining({
        providerId: 'atomic-chat',
        modelId: 'demo',
        config: expect.objectContaining({ properties: expect.objectContaining({ contextWindow: 65536 }) }),
      }),
    ])
    expect(written.config.defaultModelSelection).toMatchObject({ providerId: 'atomic-chat', modelId: 'demo' })
    expect(statSync(providerFile()).mode & 0o777).toBe(0o600)
    // Their pre-Atomic file is kept once, owner-only; ZCode's lock is not left behind.
    const backup = join(home, '.zcode', 'v2', 'provider_config.json.atomic-backup')
    expect(JSON.parse(readFileSync(backup, 'utf8'))).toEqual(theirs)
    expect(statSync(backup).mode & 0o777).toBe(0o600)
    expect(existsSync(`${providerFile()}.lock`)).toBe(false)

    // Ctrl+C: the model we loaded goes, the core stays.
    launch.child.kill('SIGINT')
    expect(await launch.exit).toBe(0)
    commands.splice(0)
    await waitForSessions(ready, 0)
    expect((await (await control(ready, '/sessions')).json()) as object).toMatchObject({ sessions: [] })
    expect(existsSync(join(dataFolder, 'atomic-core', 'instance.lock'))).toBe(true)
  }, 60_000)

  it.skipIf(process.platform === 'darwin' && existsSync('/Applications/ZCode.app'))(
    'refuses to launch an agent that is not installed, and loads nothing',
    async () => {
      await core.writeModel(dataFolder, 'demo')
      await core.writeFakeBackend(dataFolder)
      const { ready } = await core.startDaemon(dataFolder, daemons)
      const launch = core.spawnCli(
        dataFolder,
        ['launch', 'zcode', '--model', 'demo', '--port', '0'],
        shellEnv()
      )
      commands.push(launch)
      expect(await launch.exit).toBe(1)
      commands.splice(0)
      expect(launch.output()).toContain('Error: ZCode is not installed.')
      expect(launch.output()).toContain('https://zcode.z.ai/en/docs/configuration')
      expect(await sessions(ready)).toEqual([])
      expect(existsSync(providerFile())).toBe(false)
    },
    30_000
  )
})

async function waitForSessions(ready: ReadyLine, count: number): Promise<void> {
  const deadline = Date.now() + 20_000
  for (;;) {
    if ((await sessions(ready)).length === count) return
    if (Date.now() > deadline)
      throw new Error(`the owner still has ${(await sessions(ready)).length} sessions`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}
