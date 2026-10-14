/**
 * Live checks against a real `llama-server` and a real GGUF (PLAN.md §5.1 "Live"). Everything else
 * in the suite runs against the fake backend, which proves the core's own logic but cannot prove the
 * argv we emit is accepted by llama.cpp, or that a real model loads and answers.
 *
 * Opt in with:
 *   ATOMIC_LIVE=1
 *   ATOMIC_LIVE_UPSTREAM_BIN=/path/to/llama-server
 *   ATOMIC_LIVE_UPSTREAM_MODEL=/path/to/tiny-model.gguf   (a few MB is enough)
 *   ATOMIC_LIVE_UPSTREAM_TAG=b11617                       (optional; default `b<build>` from --version)
 *
 * The binary is installed under its real tag and this host's real backend id, so every build gate in
 * `planLlamaArgs` runs as it would for a user on that release.
 *
 * On Windows this is the *only* coverage of the spawn-a-backend path, because a shell-script fake
 * cannot be named `llama-server.exe`; CI therefore runs it there with a small GGUF.
 */
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeTmpDataFolder } from '../helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../helpers/tmp-data-folder.js'
import { installUpstreamPack, liveUpstreamTag, readVersion } from '../helpers/live-llamacpp.js'
import { AtomicCore } from '../../src/core/index.js'
import { parseBuildNumber } from '../../src/backend/version.js'
import {
  LOAD_MODE_ONLY_MIN_BUILD,
  REASONING_PRESERVE_DEFAULT_ON_MIN_BUILD,
} from '../../src/runtime/llamacpp/args.js'

const BIN = process.env['ATOMIC_LIVE_UPSTREAM_BIN'] ?? ''
const MODEL = process.env['ATOMIC_LIVE_UPSTREAM_MODEL'] ?? ''
const ENABLED = process.env['ATOMIC_LIVE'] === '1' && BIN !== '' && MODEL !== ''

let data: TmpDataFolder
let core: AtomicCore
let tag: string
let build: number
let exe: string
const log: string[] = []

/** The argv of the last `llama-server` core started for the `live` model, as core logged it. */
function lastArgv(): string[] {
  const line = log.filter((l) => l.startsWith('starting ') && l.includes('llamacpp-upstream/live:')).at(-1)
  expect(line, 'core logs the argv of every llama-server it starts').toBeDefined()
  return (line ?? '').slice((line ?? '').indexOf(': ') + 2).split(' ')
}

describe.skipIf(!ENABLED)('a real llama.cpp backend', () => {
  beforeAll(async () => {
    data = await makeTmpDataFolder('atomic-core-live-')
    tag = await liveUpstreamTag(BIN)
    build = parseBuildNumber(tag) ?? 0
    // Install the real build as a backend pack, so resolution, argv and env are the production path.
    exe = await installUpstreamPack(data.layout.provider('llamacpp-upstream').backendsDir, BIN, tag)
    const modelDir = join(data.layout.provider('llamacpp-upstream').modelsDir, 'live')
    await mkdir(modelDir, { recursive: true })
    const size = (await stat(MODEL)).size
    await writeFile(
      join(modelDir, 'model.yml'),
      `model_path: ${MODEL.split('\\').join('/')}\nname: live\nsize_bytes: ${size}\nmodel_size_bytes: ${size}\n`
    )
    core = await AtomicCore.create({
      dataFolder: data.root,
      controlPort: 0,
      logger: (_level, message) => log.push(message),
    })
  }, 120_000)

  afterAll(async () => {
    await core?.shutdown()
    await data?.cleanup()
  })

  it('runs the build its tag names', async () => {
    expect(build, `${tag} is a ggml-org release tag`).toBeGreaterThan(0)
    const { output, build: reported } = await readVersion(exe)
    expect(reported, `--version must report the build of ${tag}:\n${output}`).toBe(build)
  }, 60_000)

  it('loads the model, answers a completion and unloads', async () => {
    const session = await core.load('llamacpp-upstream', 'live', { overrides: { ctx_size: 512 } })
    expect(session.pid).toBeGreaterThan(0)
    expect(session.port).toBeGreaterThan(0)

    const argv = lastArgv()
    expect(argv.join(' ')).toContain('--flash-attn auto')
    expect(argv.includes('--no-reasoning-preserve'), `--no-reasoning-preserve at ${tag}`).toBe(
      build >= REASONING_PRESERVE_DEFAULT_ON_MIN_BUILD
    )

    const health = await fetch(`http://127.0.0.1:${session.port}/health`)
    expect(health.ok).toBe(true)

    const state = await core.startPublicServer({ port: 0 })
    const answer = await fetch(`http://127.0.0.1:${state.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'live',
        max_tokens: 8,
        messages: [{ role: 'user', content: 'Say hi.' }],
      }),
    })
    expect(answer.status).toBe(200)
    const body = (await answer.json()) as { choices: Array<{ message: { content: string } }> }
    expect(typeof body.choices[0]?.message.content).toBe('string')

    const device = core.llamacpp().getRuntimeDeviceInfo('live')
    expect(device, 'the device log lines must parse against a real backend').toBeDefined()

    expect(await core.unload('llamacpp-upstream', 'live')).toEqual({ success: true })
  }, 300_000)

  it('starts with the load flags its build gates select', async () => {
    // `mlock` is left alone: runners cap locked memory, and the flag spelling is gated the same way.
    const session = await core.load('llamacpp-upstream', 'live', {
      overrides: { no_mmap: true, fit: false, ctx_size: 512 },
    })
    expect(session.pid).toBeGreaterThan(0)
    const argv = lastArgv().join(' ')
    if (build >= LOAD_MODE_ONLY_MIN_BUILD) {
      expect(argv).toContain('--load-mode none')
      expect(argv).not.toContain('--no-mmap')
    } else {
      expect(argv).toContain('--no-mmap')
    }
    expect(await core.unload('llamacpp-upstream', 'live')).toEqual({ success: true })
  }, 300_000)

  it('reports the devices the real backend sees', async () => {
    const devices = await core.llamacpp().getDevices(exe)
    expect(Array.isArray(devices)).toBe(true)
    for (const device of devices) {
      expect(device.id.length).toBeGreaterThan(0)
      expect(device.mem).toBeGreaterThanOrEqual(0)
    }
  }, 60_000)
})
