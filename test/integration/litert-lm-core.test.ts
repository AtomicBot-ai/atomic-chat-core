/**
 * LiteRT-LM through the compiled core on Google's real library (change `add-litert-lm-runtime`, task
 * 6.7): the build installed from a local manifest — conf's release with the wheel from PyPI, its
 * sha256 checked by core — Gemma 4 E2B loaded on CPU, a streamed answer and a tool call through
 * `:1337`, then the unload.
 *
 * Skipped unless `LITERT_LM_TEST_LIB` and `LITERT_LM_TEST_MODEL` (a `.litertlm` that runs on CPU) are
 * set, and conf's manifest is at `LITERT_LM_TEST_MANIFEST` (default: the sibling atomic-chat-conf
 * checkout). Needs the network for the wheel.
 */

import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { BIN, control, startDaemon } from '../helpers/compiled-core.js'

const MODEL = process.env['LITERT_LM_TEST_MODEL']
const MANIFEST =
  process.env['LITERT_LM_TEST_MANIFEST'] ??
  resolve('..', 'atomic-chat-conf', 'backends', 'litert-lm-manifest.json')
const ENABLED = Boolean(process.env['LITERT_LM_TEST_LIB'] && MODEL && existsSync(MANIFEST) && existsSync(BIN))

const daemons: ChildProcess[] = []
const folders: string[] = []
afterAll(async () => {
  for (const daemon of daemons) daemon.kill('SIGTERM')
  await new Promise((done) => setTimeout(done, 1_000))
  for (const folder of folders) await rm(folder, { recursive: true, force: true })
})

const json = async (response: Response) => {
  const text = await response.text()
  expect(response.ok, text).toBe(true)
  return JSON.parse(text) as Record<string, unknown>
}

describe.skipIf(!ENABLED)('LiteRT-LM through the core on the real library (task 6.7)', () => {
  it('installs the build, loads Gemma on CPU, streams and calls a tool through :1337, and unloads', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'atomic-litert-core-'))
    folders.push(folder)
    const conf = JSON.parse(await readFile(MANIFEST, 'utf8')) as { releases: Array<Record<string, unknown>> }
    const manifest = join(folder, 'litert-lm-manifest.json')
    // conf's release asks for the core version that ships this change; this checkout is older.
    await writeFile(
      manifest,
      JSON.stringify({
        schema_version: 1,
        releases: conf.releases.map((release) => ({ ...release, min_core_version: '0.1.0' })),
      })
    )
    const { ready } = await startDaemon(folder, daemons, [], {
      ATOMIC_LITERT_LM_MANIFEST_URL: pathToFileURL(manifest).href,
    })
    const call = (path: string, body?: unknown) =>
      control(folder, ready, path, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) })

    const installed = await json(await call('/engine-builds/litert-lm/install', { task_id: 'it-litert' }))
    expect(installed).toMatchObject({ installed: true, build: { tag: '0.18.1' } })

    const id = 'gemma-4-e2b-cpu'
    const dir = join(folder, 'litert-lm', 'models', id)
    await mkdir(dir, { recursive: true })
    const file = basename(MODEL as string)
    await symlink(MODEL as string, join(dir, file))
    await writeFile(
      join(dir, 'model.yml'),
      [
        `model_path: litert-lm/models/${id}/${file}`,
        `name: ${id}`,
        'size_bytes: 1',
        'litert_lm:',
        '  model_id: gemma-4-e2b',
        `  variant_id: ${id}`,
        '  backend: cpu',
        '  repo: litert-community/gemma-4-E2B-it-litert-lm',
        `  revision: ${'a'.repeat(40)}`,
        `  file: ${file}`,
        '  context_length: 4096',
        '  tools: true',
        '  reasoning: false',
        '  vision: true',
        '  source: curated',
        '',
      ].join('\n')
    )
    const check = await json(await call('/models/litert-lm/check', { model_id: id }))
    expect(check).toMatchObject({ verdict: 'ok', metadata: { backends: expect.arrayContaining(['cpu']) } })

    const loaded = await call(`/models/litert-lm/${id}/load`, {})
    expect(loaded.status, await loaded.clone().text()).toBe(200)
    const { port } = (await json(await call('/server/start', { port: 0 }))) as { port: number }
    const post = (body: unknown) =>
      fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: id, ...(body as object) }),
      })

    const streamed = await (
      await post({
        messages: [{ role: 'user', content: 'Say the word "banana" and nothing else.' }],
        stream: true,
      })
    ).text()
    const frames = streamed.split('\n\n').filter(Boolean)
    expect(frames.at(-1)).toBe('data: [DONE]')
    const content = frames
      .slice(0, -1)
      .map((frame) => JSON.parse(frame.slice(6)) as { choices: Array<{ delta?: { content?: string } }> })
      .map((chunk) => chunk.choices[0]?.delta?.content ?? '')
      .join('')
    expect(content.toLowerCase()).toContain('banana')

    const tool = (await json(
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
    )) as {
      choices: Array<{
        finish_reason: string
        message: { tool_calls?: Array<{ function: { name: string } }> }
      }>
    }
    expect(tool.choices[0]?.finish_reason).toBe('tool_calls')
    expect(tool.choices[0]?.message.tool_calls?.[0]?.function.name).toBe('get_weather')

    expect(await json(await call(`/models/litert-lm/${id}/unload`, {}))).toMatchObject({ success: true })
    expect(await json(await call('/sessions'))).toMatchObject({ sessions: [] })
  })
})
