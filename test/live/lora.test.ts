import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { decodePng } from '../../src/diffusion/png.js'
import { sha256File } from '../../src/downloads/index.js'
import { cp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { AtomicCore } from '../../src/core/index.js'
import { CoreClient } from '../../src/client/index.js'
import { prepareSdcppTree, writeInstallRecord } from '../../src/diffusion/install.js'
import { makeTmpDataFolder } from '../helpers/tmp-data-folder.js'
import { installUpstreamPack, liveUpstreamTag } from '../helpers/live-llamacpp.js'
import type { LoraArtifact } from '../../src/drafters/lora-catalog.js'

// Run with ATOMIC_LIVE=1 and ATOMIC_LIVE_LORA_CHAT, IMAGE or VIDEO
// (each value is the catalog SHA-256 or a local reference file to hash).
// The owner downloads the pinned adapter into a fresh data directory. Chat uses
// ATOMIC_LIVE_UPSTREAM_BIN and ATOMIC_LIVE_UPSTREAM_MODEL; ATOMIC_LIVE_LORA_DSPARK
// optionally selects a second verified download. Media uses the SD engine and
// component paths below. The video comparison needs ffmpeg on PATH.
const env = process.env
for (const mode of ['chat', 'image', 'video'] as const) {
  const adapter = env['ATOMIC_LIVE_LORA_' + mode.toUpperCase()]
  it.skipIf(env.ATOMIC_LIVE !== '1' || !adapter)(
    'applies and disables a real ' + mode + ' LoRA through the control API',
    async () => {
      const data = await makeTmpDataFolder('atomic-lora-live-')
      let core: AtomicCore | undefined
      try {
        const draft = mode === 'chat' ? env.ATOMIC_LIVE_LORA_DSPARK : undefined
        core = await AtomicCore.create({ dataFolder: data.root, controlPort: 0, telemetry: false })
        const host = core
        const client = new CoreClient({ baseUrl: host.control.url, token: host.controlToken })
        const call = <T>(path: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET', body?: unknown) =>
          client.request<T>(method, path, body)
        const digest = /^[a-f0-9]{64}$/.test(adapter!) ? adapter : await sha256File(adapter!)
        const family = mode === 'video' ? 'wan2.2-ti2v-5b' : 'flux.2-klein'
        const model = mode === 'chat' ? 'live' : family + ':live'
        const row = (await call<{ results: LoraArtifact[] }>('/loras/search')).results.find(
          (r) => r.mode === mode && r.sha256 === digest
        )!
        expect(row).toBeDefined()
        if (mode === 'chat') {
          const exe = env.ATOMIC_LIVE_UPSTREAM_BIN!
          await installUpstreamPack(
            data.layout.provider('llamacpp-upstream').backendsDir,
            exe,
            await liveUpstreamTag(exe)
          )
          const dir = join(data.layout.provider('llamacpp-upstream').modelsDir, model)
          await mkdir(dir, { recursive: true })
          await writeFile(
            join(dir, 'model.yml'),
            'model_path: ' +
              JSON.stringify(env.ATOMIC_LIVE_UPSTREAM_MODEL) +
              '\nname: live\nsource_repo: ' +
              row.target +
              '\n'
          )
          if (draft) {
            const draftId = /^[a-f0-9]{64}$/.test(draft) ? draft : await sha256File(draft)
            const drafter = (
              await call<{ results: LoraArtifact[] }>(
                '/drafters/search?target=' + encodeURIComponent(row.target)
              )
            ).results.find((entry) => entry.sha256 === draftId)!
            await call('/drafters/' + drafter.sha256 + '/install', 'POST')
            await call('/models/llamacpp-upstream/live/drafter', 'PUT', { id: drafter.sha256 })
          }
          await host.load('llamacpp-upstream', model, {
            overrides: { fit: false, ctx_size: 1024, parallel: 1 },
          })
        } else {
          const tag = env.ATOMIC_LIVE_SD_TAG!
          const dir = join(data.layout.diffusion.backendsDir, tag, 'live')
          await mkdir(dir, { recursive: true })
          await cp(env.ATOMIC_LIVE_SD_ENGINE!, dir, { recursive: true })
          await prepareSdcppTree(dir)
          await writeInstallRecord(dir, {
            tag,
            backendId: 'live',
            backend: process.platform === 'darwin' ? 'metal' : 'cpu',
            engine: 'sd-cpp',
            sha256: null,
            installedAtMs: Date.now(),
            dir,
          })
          await client.configureDiffusion({ dataFolder: data.root, idleUnloadSecs: 0 })
          const files =
            mode === 'image'
              ? {
                  diffusionModel: env.ATOMIC_LIVE_SD_MODEL!,
                  vae: env.ATOMIC_LIVE_SD_VAE!,
                  llm: env.ATOMIC_LIVE_SD_LLM!,
                  vaeFormat: 'flux2',
                }
              : {
                  diffusionModel: env.ATOMIC_LIVE_SD_VIDEO_MODEL!,
                  vae: env.ATOMIC_LIVE_SD_VIDEO_VAE!,
                  t5xxl: env.ATOMIC_LIVE_SD_VIDEO_T5XXL!,
                }
          await client.loadDiffusionModel({
            modelId: model,
            family,
            modality: mode,
            displayName: family,
            files,
            defaults: {
              steps: 2,
              cfgScale: 1,
              width: 256,
              height: 256,
              ...(mode === 'video'
                ? {
                    samplingMethod: 'euler',
                    video: {
                      fps: 12,
                      frames: 5,
                      frameStep: 4,
                      frameOffset: 1,
                      resolutionPresets: [[256, 256]],
                    },
                  }
                : {}),
            },
            ranges: { steps: [1, 50], dims: [256, 1024], dimMultiple: 32, frames: [5, 33] },
            offload: 'group',
            startupTimeoutSecs: 600,
          })
        }
        await call('/loras/' + row.sha256 + '/install', 'POST')
        const path = '/loras/choices/' + mode + '/' + encodeURIComponent(model)
        expect(await call(path)).toMatchObject({ adapterId: null, files: [row] })
        const port = (await host.startPublicServer({ port: 0 })).port
        const outputs = new Set<string>()
        for (const adapterId of [row.sha256, null]) {
          await call(path, 'PUT', { adapterId })
          expect(await call(path)).toMatchObject({ adapterId })
          if (mode === 'chat') {
            const res = await fetch('http://127.0.0.1:' + port + '/v1/chat/completions', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                model,
                messages: [{ role: 'user', content: 'Count to three. /no_think' }],
                temperature: 0,
                max_tokens: 32,
              }),
            })
            const reply = (await res.json()) as {
              choices?: { message: { content: string } }[]
              timings?: { draft_n: number }
            }
            expect(res.ok, JSON.stringify(reply)).toBe(true)
            expect(reply.choices?.[0]?.message.content).toBeTruthy()
            if (draft) expect(reply.timings?.draft_n).toBeGreaterThan(0)
          } else {
            const params = {
              prompt: 'A red robot on a blue background',
              width: 256,
              height: 256,
              seed: 42,
              steps: 2,
              cfgScale: 1,
            }
            const { jobId } =
              mode === 'image'
                ? await client.generateImage({ ...params, batchSize: 1 })
                : await client.generateVideo({ ...params, frames: 5 })
            const until = Date.now() + 600000
            let job
            do {
              job = mode === 'image' ? await client.diffusionJob(jobId) : await client.videoJob(jobId)
              if (job && ['completed', 'failed', 'cancelled'].includes(job.state)) break
              await new Promise((r) => setTimeout(r, 500))
            } while (Date.now() < until)
            expect(job?.state, JSON.stringify(job?.error)).toBe('completed')
            const path = job!.outputs[0]!.path
            const pixels =
              mode === 'image'
                ? (await decodePng(await readFile(path))).data
                : execFileSync(
                    'ffmpeg',
                    ['-v', 'error', '-i', path, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
                    { maxBuffer: 8 * 1024 * 1024 }
                  )
            outputs.add(createHash('sha256').update(pixels).digest('hex'))
          }
        }
        if (mode !== 'chat') expect(outputs.size, 'LoRA should change the output for the same seed').toBe(2)
        await call('/loras/' + row.sha256, 'DELETE')
        expect(await call(path)).toMatchObject({ adapterId: null, files: [] })
      } finally {
        await core?.shutdown()
        await data.cleanup()
      }
    },
    1500000
  )
}
