/**
 * Live checks of the TurboQuant provider (`llamacpp`, PLAN.md stage 5) against a real fork build and
 * a real GGUF: the fork accepts the argv the core emits for it — `turbo3` KV cache, flash attention
 * in string form — selects that pack among installed ones with its own matrix, and answers.
 *
 * Opt in with:
 *   ATOMIC_LIVE=1
 *   ATOMIC_LIVE_TURBOQUANT_BIN=/path/to/<tag>/<backend>/build/bin/llama-server   (a fork release)
 *   ATOMIC_LIVE_TURBOQUANT_MODEL=/path/to/model.gguf
 *   ATOMIC_LIVE_TURBOQUANT_TAG=b10269-1.6.0        (optional; the tag the pack is installed under)
 */
import { chmod, cp, mkdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeTmpDataFolder } from '../helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../helpers/tmp-data-folder.js'
import { AtomicCore } from '../../src/core/index.js'
import { llamaServerExeName } from '../../src/config/index.js'

const BIN = process.env['ATOMIC_LIVE_TURBOQUANT_BIN'] ?? ''
const MODEL = process.env['ATOMIC_LIVE_TURBOQUANT_MODEL'] ?? ''
const TAG = process.env['ATOMIC_LIVE_TURBOQUANT_TAG'] ?? 'b10269-1.6.0'
const ENABLED = process.env['ATOMIC_LIVE'] === '1' && BIN !== '' && MODEL !== ''

/** The backend id this host's fork build is published under. */
function hostBackend(): string {
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'macos-arm64' : 'macos-x64'
  if (process.platform === 'win32') return 'windows-x64-cpu'
  return 'linux-x64-vulkan'
}

let data: TmpDataFolder
let core: AtomicCore

describe.skipIf(!ENABLED)('a real TurboQuant fork build', () => {
  beforeAll(async () => {
    data = await makeTmpDataFolder('atomic-core-live-tq-')
    // The whole bin folder: llama-server links against the ggml libraries beside it.
    const packDir = join(data.layout.provider('llamacpp').backendsDir, TAG, hostBackend(), 'build', 'bin')
    await mkdir(packDir, { recursive: true })
    await cp(dirname(BIN), packDir, { recursive: true })
    if (process.platform !== 'win32') await chmod(join(packDir, llamaServerExeName(process.platform)), 0o755)
    const modelDir = join(data.layout.provider('llamacpp').modelsDir, 'live-tq')
    await mkdir(modelDir, { recursive: true })
    const size = (await stat(MODEL)).size
    await writeFile(
      join(modelDir, 'model.yml'),
      `model_path: ${MODEL.split('\\').join('/')}\nname: ${basename(MODEL)}\nsize_bytes: ${size}\nmodel_size_bytes: ${size}\n`
    )
    core = await AtomicCore.create({ dataFolder: data.root, controlPort: 0 })
    // What a TurboQuant user runs with: the fork's default turbo3 cache, and no backend pinned —
    // the core has to find the installed fork pack itself.
    await core.settings.update('llamacpp', {
      version_backend: '',
      cache_type_k: 'turbo3',
      cache_type_v: 'turbo3',
      flash_attn: 'auto',
      fit: false,
    })
  }, 120_000)

  afterAll(async () => {
    await core?.shutdown()
    await data?.cleanup()
  })

  it('loads with a turbo3 KV cache, answers through the public API, grows its context and unloads', async () => {
    const session = await core.load('llamacpp', 'live-tq', { overrides: { ctx_size: 2048 } })
    expect(session.pid).toBeGreaterThan(0)
    // What the running fork was started with; a sanitised cache would read q8_0 here.
    if (process.platform !== 'win32') {
      const { execFileSync } = await import('node:child_process')
      const args = execFileSync('ps', ['-p', String(session.pid), '-o', 'args='], { encoding: 'utf8' })
      expect(args).toContain('--cache-type-k turbo3')
      expect(args).toContain('--cache-type-v turbo3')
      expect(args).toContain('--flash-attn auto')
    }
    expect(core.sessions()).toMatchObject([{ provider: 'llamacpp', model_id: 'live-tq' }])

    const state = await core.startPublicServer({ port: 0 })
    const answer = await fetch(`http://127.0.0.1:${state.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'live-tq',
        max_tokens: 8,
        messages: [{ role: 'user', content: 'Say hi.' }],
      }),
    })
    expect(answer.status).toBe(200)
    const body = (await answer.json()) as { choices: Array<{ message: { content?: string } }> }
    expect(body.choices).toHaveLength(1)

    expect(core.llamacpp('llamacpp').getRuntimeDeviceInfo('live-tq')).toBeDefined()
    const grown = await core.increaseCtx('llamacpp', 'live-tq', 'live')
    expect(grown).toMatchObject({ ok: true, new_ctx_len: 8192 })

    expect(await core.unload('llamacpp', 'live-tq')).toEqual({ success: true })
  }, 600_000)
})
