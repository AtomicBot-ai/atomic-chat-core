/**
 * Stage 4d through the compiled binary: `api:request` events on the control event stream (what the
 * app feeds its analytics and API screen from), and engines another process owns registered with the
 * daemon, routed to, and grown through their owner.
 */
import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as core from '../helpers/compiled-core.js'
import type { ReadyLine } from '../helpers/compiled-core.js'
import { json, startStub } from '../helpers/chatgpt-stub.js'
import type { Stub } from '../helpers/chatgpt-stub.js'

let dataFolder: string
const daemons: ChildProcess[] = []
const stubs: Stub[] = []
const streams: AbortController[] = []

beforeEach(async () => {
  dataFolder = await mkdtemp(join(tmpdir(), 'atomic-core-events-e2e-'))
})
afterEach(async () => {
  for (const s of streams.splice(0)) s.abort()
  for (const daemon of daemons.splice(0)) daemon.kill('SIGKILL')
  core.reapJournalledChildren(dataFolder)
  await Promise.all(stubs.splice(0).map((s) => s.close()))
  await rm(dataFolder, { recursive: true, force: true })
})

const control = (ready: ReadyLine, path: string, init: RequestInit = {}) =>
  core.control(dataFolder, ready, path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  })

/** Collect every event of the control stream from now on. */
async function events(ready: ReadyLine): Promise<Array<{ event: string; data: Record<string, unknown> }>> {
  const controller = new AbortController()
  streams.push(controller)
  const res = await core.control(dataFolder, ready, '/events', { signal: controller.signal })
  const seen: Array<{ event: string; data: Record<string, unknown> }> = []
  void (async () => {
    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    let pending = ''
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        pending += decoder.decode(value, { stream: true })
        const frames = pending.split('\n\n')
        pending = frames.pop() ?? ''
        for (const frame of frames) {
          const event = /^event: (.*)$/m.exec(frame)?.[1]
          const data = /^data: (.*)$/m.exec(frame)?.[1]
          if (event && data) seen.push({ event, data: JSON.parse(data) as Record<string, unknown> })
        }
      }
    } catch {
      // aborted at the end of the test
    }
  })()
  return seen
}

describe.skipIf(!existsSync(core.BIN))('the compiled core reports and routes', () => {
  it('reports each API request on the event stream, with previews only while the API screen watches', async () => {
    const engine = await startStub((_req, res) =>
      json(res, 200, { choices: [{ message: { content: 'engine says hi' } }] })
    )
    stubs.push(engine)
    const { ready } = await core.startDaemon(dataFolder, daemons)
    const seen = await events(ready)
    await control(ready, '/external-sessions/test-app', {
      method: 'PUT',
      body: JSON.stringify({
        generation: 1,
        sessions: [{ provider: 'mlx', model_id: 'demo', port: engine.port }],
      }),
    })
    const port = (
      (await (await control(ready, '/server/start', { method: 'POST', body: '{"port":0}' })).json()) as {
        port: number
      }
    ).port
    const chat = () =>
      fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'demo', messages: [{ role: 'user', content: 'private words' }] }),
      }).then((r) => r.text())

    await chat()
    await expect.poll(() => seen.filter((e) => e.event === 'api:request').length).toBe(1)
    const quiet = seen.find((e) => e.event === 'api:request')?.data
    expect(quiet).toMatchObject({
      phase: 'finished',
      finish: null,
      observation: {
        endpoint: 'chat/completions',
        backend: 'mlx',
        model_id: 'demo',
        status: 200,
        error_kind: null,
      },
    })
    expect(JSON.stringify(seen)).not.toContain('private words')

    await control(ready, '/server/inspector', { method: 'PUT', body: '{"enabled":true}' })
    await chat()
    await expect.poll(() => seen.filter((e) => e.event === 'api:request').length).toBe(3)
    const [started, finished] = seen.filter((e) => e.event === 'api:request').slice(1)
    expect(started?.data).toMatchObject({
      phase: 'started',
      prompt_preview: 'private words',
      message_count: 1,
    })
    expect(finished?.data).toMatchObject({
      phase: 'finished',
      finish: { status: 200, reply_preview: 'engine says hi' },
    })
  })

  it('routes to an engine another process owns and asks that owner to grow its context', async () => {
    let engineCalls = 0
    const engine = await startStub((_req, res) => {
      engineCalls++
      if (engineCalls === 1)
        return json(res, 500, { error: { message: 'the request exceeds the available context size' } })
      json(res, 200, { choices: [{ message: { content: 'after the owner reloaded' } }] })
    })
    stubs.push(engine)
    const { ready } = await core.startDaemon(dataFolder, daemons)
    const seen = await events(ready)
    await control(ready, '/external-sessions/test-app', {
      method: 'PUT',
      body: JSON.stringify({
        generation: 3,
        sessions: [{ provider: 'llamacpp', model_id: 'turbo.q4', port: engine.port, api_key: 'owner-key' }],
      }),
    })
    const stale = await control(ready, '/external-sessions/test-app', {
      method: 'PUT',
      body: JSON.stringify({ generation: 2, sessions: [] }),
    })
    expect(stale.status).toBe(409)
    const port = (
      (await (await control(ready, '/server/start', { method: 'POST', body: '{"port":0}' })).json()) as {
        port: number
      }
    ).port

    const answering = (async () => {
      await expect
        .poll(() => seen.some((e) => e.event === 'external-sessions:ctx-requested'), { timeout: 10_000 })
        .toBe(true)
      const asked = seen.find((e) => e.event === 'external-sessions:ctx-requested')?.data as {
        request_id: string
        model_id: string
      }
      expect(asked.model_id).toBe('turbo.q4')
      await control(ready, `/external-sessions/test-app/ctx/${asked.request_id}`, {
        method: 'POST',
        body: JSON.stringify({ ok: true, new_ctx_len: 16384 }),
      })
    })()
    const answer = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'turbo_q4', messages: [] }),
    })
    await answering

    expect(await answer.json()).toEqual({ choices: [{ message: { content: 'after the owner reloaded' } }] })
    expect(engine.requests[0]?.headers.authorization).toBe('Bearer owner-key')
    expect(engineCalls).toBe(2)
  })
})
