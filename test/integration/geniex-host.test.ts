/**
 * `geniex-host` of the compiled binary against Qualcomm's real SDK (change `add-geniex-runtime`,
 * task 5.1; the spike's S1 and S2 run through it). Skipped unless `GENIEX_TEST_LIB` names a build (a
 * folder with `lib/` holding `geniex.dll`, as an install leaves it); the `serve` part also needs
 * `GENIEX_TEST_MODEL`, a Q4_0 GGUF file (Qwen3 4B), and takes `GENIEX_TEST_DEVICE` (default `cpu`).
 * Windows arm64 only: the SDK has no other build.
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BIN } from '../helpers/compiled-core.js'

const LIB = process.env['GENIEX_TEST_LIB']
const MODEL = process.env['GENIEX_TEST_MODEL']
const DEVICE = process.env['GENIEX_TEST_DEVICE'] ?? 'cpu'

const host = (...args: string[]) =>
  spawnSync(BIN, ['geniex-host', ...args], { encoding: 'utf8', timeout: 180_000 })

describe.skipIf(!LIB || !existsSync(BIN))('geniex-host on the real library (spike S1)', () => {
  it('probe opens geniex.dll from the build folder, with no driver install, and names the devices', () => {
    const result = host('probe', '--lib', LIB as string)
    expect(result.status, result.stderr).toBe(0)
    const answer = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}') as Record<string, unknown>
    expect(answer).toMatchObject({ abi: 1, plugins: expect.arrayContaining(['llama_cpp']) })
    expect(answer['version']).toMatch(/^\d+\.\d+\.\d+$/)
    // S1: HTP0 without `pnputil`; GPUOpenCL beside it.
    expect(answer['devices']).toEqual(expect.arrayContaining(['HTP0', 'GPUOpenCL']))
  })

  it.skipIf(!MODEL)(
    'inspect reads the GGUF header without the library, and exits 4 on a file that is not one',
    async () => {
      const result = host('inspect', MODEL as string)
      expect(result.status, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout.trim())).toMatchObject({
        kind: 'gguf',
        quantization: 'Q4_0',
        chat_template: true,
      })
      const dir = await mkdtemp(join(tmpdir(), 'atomic-geniex-int-'))
      try {
        const broken = host('inspect', join(dir, 'missing.gguf'))
        expect(broken.status).toBe(4)
        expect(broken.stdout).toBe('')
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    }
  )
})

describe.skipIf(!LIB || !MODEL || !existsSync(BIN))(
  'geniex-host serve on the real library (spike S2)',
  () => {
    let child: ReturnType<typeof spawn>
    let url = ''
    let dir = ''
    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), 'atomic-geniex-serve-'))
      child = spawn(
        BIN,
        [
          'geniex-host',
          'serve',
          '--lib',
          LIB as string,
          '--engine-version',
          '0.9.3',
          '--model',
          MODEL as string,
          '--plugin',
          'llama_cpp',
          '--device',
          DEVICE,
          '--nctx',
          '4096',
          '--max-tokens',
          '512',
          '--power-mode',
          'burst',
          '--port',
          '0',
          '--tmp',
          join(dir, 'tmp'),
          '--id',
          'it-model',
        ],
        { stdio: ['pipe', 'pipe', 'inherit'] }
      )
      const lines = createInterface({ input: child.stdout as NonNullable<typeof child.stdout> })
      url = await new Promise<string>((resolve, reject) => {
        lines.on('line', (line) => {
          const ready = JSON.parse(line) as { url?: string }
          if (ready.url) resolve(ready.url)
        })
        child.on('exit', (code) =>
          reject(new Error(`geniex-host exited ${String(code)} before it was ready`))
        )
      })
    }, 600_000)
    afterAll(async () => {
      child?.stdin?.end()
      await new Promise((resolve) => child?.on('exit', resolve))
      await rm(dir, { recursive: true, force: true })
    })

    const post = (body: unknown) =>
      fetch(`${url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })

    it('lists the model and streams an answer that ends with [DONE]; a second request follows the first', async () => {
      const models = (await (await fetch(`${url}/v1/models`)).json()) as { data: Array<{ id: string }> }
      expect(models.data[0]?.id).toBe('it-model')
      for (const word of ['banana', 'cherry']) {
        const text = await (
          await post({
            messages: [{ role: 'user', content: `Say the word "${word}" and nothing else.` }],
            stream: true,
            stream_options: { include_usage: true },
            chat_template_kwargs: { enable_thinking: false },
          })
        ).text()
        const frames = text.split('\n\n').filter(Boolean)
        expect(frames.at(-1)).toBe('data: [DONE]')
        const content = frames
          .slice(0, -1)
          .map((frame) => JSON.parse(frame.slice(6)) as { choices: Array<{ delta?: { content?: string } }> })
          .map((chunk) => chunk.choices[0]?.delta?.content ?? '')
          .join('')
        expect(content.toLowerCase()).toContain(word)
      }
    }, 300_000)

    it('returns a tool call for a question the tool answers, and JSON by a schema', async () => {
      const body = (await (
        await post({
          messages: [{ role: 'user', content: 'What is the weather in Paris right now? Use the tool.' }],
          tools: [
            {
              type: 'function',
              function: {
                name: 'get_weather',
                description: 'Get the current weather in a city',
                parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
              },
            },
          ],
          chat_template_kwargs: { enable_thinking: false },
        })
      ).json()) as {
        choices: Array<{
          finish_reason: string
          message: { tool_calls?: Array<{ function: { name: string; arguments: string } }> }
        }>
      }
      expect(body.choices[0]?.finish_reason).toBe('tool_calls')
      expect(body.choices[0]?.message.tool_calls?.[0]?.function.name).toBe('get_weather')
      expect(JSON.parse(body.choices[0]?.message.tool_calls?.[0]?.function.arguments ?? '{}')).toMatchObject({
        city: expect.stringMatching(/paris/i),
      })

      const json = (await (
        await post({
          messages: [{ role: 'user', content: 'Give the capital of France as JSON with a "capital" key.' }],
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'c',
              schema: {
                type: 'object',
                properties: { capital: { type: 'string' } },
                required: ['capital'],
                additionalProperties: false,
              },
            },
          },
          chat_template_kwargs: { enable_thinking: false },
        })
      ).json()) as { choices: Array<{ message: { content: string } }> }
      expect(JSON.parse(json.choices[0]?.message.content ?? '')).toMatchObject({
        capital: expect.stringMatching(/paris/i),
      })
    }, 300_000)

    it('stops generating when the client hangs up, and the next request starts at once', async () => {
      const started = post({
        messages: [{ role: 'user', content: 'Count from 1 to 10000, one number per line.' }],
        stream: true,
      })
      const response = await started
      const reader = response.body?.getReader()
      await reader?.read()
      await reader?.read()
      await reader?.cancel()
      const begun = Date.now()
      const next = await post({
        messages: [{ role: 'user', content: 'Say "ok".' }],
        chat_template_kwargs: { enable_thinking: false },
      })
      expect(next.status).toBe(200)
      expect(Date.now() - begun).toBeLessThan(60_000)
    }, 300_000)
  }
)
