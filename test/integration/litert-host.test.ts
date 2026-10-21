/**
 * `litert-host` of the compiled binary against Google's real library (change `add-litert-lm-runtime`,
 * task 5.1). Skipped unless `LITERT_LM_TEST_LIB` names a build (a folder with `lib/` holding the
 * library, as an install leaves it); the `serve` part also needs `LITERT_LM_TEST_MODEL`, a
 * `.litertlm` file that runs on CPU (Gemma 4 E2B).
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BIN } from '../helpers/compiled-core.js'

const LIB = process.env['LITERT_LM_TEST_LIB']
const MODEL = process.env['LITERT_LM_TEST_MODEL']

const host = (...args: string[]) =>
  spawnSync(BIN, ['litert-host', ...args], { encoding: 'utf8', timeout: 120_000 })

describe.skipIf(!LIB || !existsSync(BIN))('litert-host on the real library', () => {
  it('probe opens the library and compiles its stream shim', () => {
    const result = host('probe', '--lib', LIB as string)
    expect(result.status, result.stderr).toBe(0)
    const answer = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}') as Record<string, unknown>
    expect(answer).toMatchObject({ abi: 1, backends: expect.arrayContaining(['cpu', 'gpu']) })
    if (process.platform !== 'win32') expect(answer['version']).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it.skipIf(!MODEL)(
    'inspect reads the file without an engine, and exits 4 on a file that is not one',
    async () => {
      const result = host('inspect', '--lib', LIB as string, MODEL as string)
      expect(result.status, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout.trim())).toMatchObject({
        model_type: 'llm',
        backends: expect.arrayContaining(['cpu']),
        modalities: expect.arrayContaining(['text']),
      })
      const dir = await mkdtemp(join(tmpdir(), 'atomic-litert-int-'))
      try {
        const broken = host('inspect', '--lib', LIB as string, join(dir, 'missing.litertlm'))
        expect(broken.status).toBe(4)
        expect(broken.stdout).toBe('')
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    }
  )
})

describe.skipIf(!LIB || !MODEL || !existsSync(BIN))('litert-host serve on the real library', () => {
  let child: ReturnType<typeof spawn>
  let url = ''
  let dir = ''
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'atomic-litert-serve-'))
    child = spawn(
      BIN,
      [
        'litert-host',
        'serve',
        '--lib',
        LIB as string,
        '--engine-version',
        '0.18.1',
        '--model',
        MODEL as string,
        '--backend',
        'cpu',
        '--max-tokens',
        '4096',
        '--port',
        '0',
        '--cache',
        join(dir, 'cache'),
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
      child.on('exit', (code) => reject(new Error(`litert-host exited ${String(code)} before it was ready`)))
    })
  }, 300_000)
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

  it('lists the model and streams an answer that ends with [DONE]', async () => {
    const models = (await (await fetch(`${url}/v1/models`)).json()) as { data: Array<{ id: string }> }
    expect(models.data[0]?.id).toBe('it-model')
    const text = await (
      await post({
        messages: [{ role: 'user', content: 'Say the word "banana" and nothing else.' }],
        stream: true,
        stream_options: { include_usage: true },
      })
    ).text()
    const frames = text.split('\n\n').filter(Boolean)
    expect(frames.at(-1)).toBe('data: [DONE]')
    const content = frames
      .slice(0, -1)
      .map((frame) => JSON.parse(frame.slice(6)) as { choices: Array<{ delta?: { content?: string } }> })
      .map((chunk) => chunk.choices[0]?.delta?.content ?? '')
      .join('')
    expect(content.toLowerCase()).toContain('banana')
  })

  it('returns a tool call for a question the tool answers', async () => {
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
  })
})
