import { openAsBlob } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { AtomicCore } from '../../src/core/index.js'
import { makeTmpDataFolder } from '../helpers/tmp-data-folder.js'
import { installUpstreamPack, liveUpstreamTag } from '../helpers/live-llamacpp.js'
import type { Drafter } from '../../src/drafters/index.js'

const exe = process.env.ATOMIC_LIVE_UPSTREAM_BIN
const base = process.env.ATOMIC_LIVE_UPSTREAM_MODEL
const head = process.env.ATOMIC_LIVE_DSPARK_HEAD
const target = process.env.ATOMIC_LIVE_DSPARK_TARGET ?? 'Qwen/Qwen3-4B'
it.skipIf(process.env.ATOMIC_LIVE !== '1' || !exe || !base || !head)(
  'installs, switches and removes DSpark through the desktop control API on a real backend',
  async () => {
    const data = await makeTmpDataFolder('atomic-dspark-live-')
    let core: AtomicCore | undefined
    try {
      await installUpstreamPack(
        data.layout.provider('llamacpp-upstream').backendsDir,
        exe!,
        await liveUpstreamTag(exe!)
      )
      const dir = join(data.layout.provider('llamacpp-upstream').modelsDir, 'live')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'model.yml'), `model_path: ${JSON.stringify(base)}\nname: live\n`)
      const blob = await openAsBlob(head!)
      core = await AtomicCore.create({
        dataFolder: data.root,
        controlPort: 0,
        telemetry: false,
        fetch: async (url, init) => {
          if (String(url).startsWith('https://huggingface.co/') && String(url).endsWith('.gguf'))
            return new Response(init?.method === 'HEAD' ? null : blob, {
              headers: { 'content-length': String(blob.size) },
            })
          return fetch(url, init)
        },
      })
      const host = core
      const call = async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
        const response = await fetch('http://127.0.0.1:' + host.control.port + '/atomic/v1' + path, {
          method,
          headers: { 'authorization': 'Bearer ' + host.controlToken, 'content-type': 'application/json' },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        })
        const result = await response.json()
        expect(response.ok, JSON.stringify(result)).toBe(true)
        return result as T
      }
      const found = await call<{ results: Drafter[] }>(
        '/drafters/search?source=' + encodeURIComponent(target)
      )
      const row = found.results[0]!
      expect(row.target).toBe(target)
      await call('/drafters/' + row.sha256 + '/install', 'POST')
      const choice = '/models/llamacpp-upstream/live/drafter'
      expect(await call(choice)).toMatchObject({ id: null, files: [{ sha256: row.sha256 }] })
      await host.load('llamacpp-upstream', 'live', { overrides: { fit: false, ctx_size: 2048, parallel: 1 } })
      await call(choice, 'PUT', { id: row.sha256 })
      const port = (await host.startPublicServer({ port: 0 })).port
      const chat = async (content: string, options: Record<string, unknown> = {}) => {
        const response = await fetch('http://127.0.0.1:' + port + '/v1/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'live',
            temperature: 0,
            max_tokens: 64,
            messages: [{ role: 'user', content }],
            ...options,
          }),
        })
        const reply = (await response.json()) as {
          choices: {
            message: {
              content?: string
              reasoning_content?: string
              tool_calls?: { function: { name: string; arguments: string } }[]
            }
          }[]
          timings?: { draft_n?: number; draft_n_accepted?: number }
        }
        expect(response.ok, JSON.stringify(reply)).toBe(true)
        return reply
      }
      const question = 'Count to ten. /no_think'
      const answer = await chat(question)
      expect(answer.choices[0]?.message.content).toBeTruthy()
      expect(answer.timings?.draft_n_accepted).toBeGreaterThan(0)
      const reasoning = await chat('What is 12 times 17? /think', {
        max_tokens: 256,
        reasoning_budget_tokens: 96,
      })
      expect(reasoning.choices[0]?.message.reasoning_content).toBeTruthy()
      expect(reasoning.choices[0]?.message.content).toContain('204')
      const tools = [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Get weather',
            parameters: {
              type: 'object',
              properties: { city: { type: 'string' } },
              required: ['city'],
            },
          },
        },
      ]
      const toolReply = await chat('Use get_weather for Paris. /no_think', { tools, max_tokens: 160 })
      const fn = toolReply.choices[0]?.message.tool_calls?.[0]?.function
      expect(fn?.name).toBe('get_weather')
      expect(JSON.parse(fn!.arguments)).toMatchObject({ city: 'Paris' })
      await call(choice, 'PUT', { id: null })
      const plain = await chat(question)
      expect(plain.choices[0]?.message.content).toBeTruthy()
      expect(plain.timings?.draft_n ?? 0).toBe(0)
      await call('/drafters/' + row.sha256, 'DELETE')
      expect(await call(choice)).toMatchObject({ id: null, files: [] })
    } finally {
      await core?.shutdown()
      await data.cleanup()
    }
  },
  180_000
)
