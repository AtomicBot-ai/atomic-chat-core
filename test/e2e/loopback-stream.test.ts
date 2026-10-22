/** The installed core's delayed loopback SSE path, including client disconnect. */
import type { ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as core from '../helpers/compiled-core.js'
import { makeTmpDataFolder } from '../helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../helpers/tmp-data-folder.js'
import { delayedSseServer } from '../helpers/delayed-sse.js'

let data: TmpDataFolder
const daemons: ChildProcess[] = []
beforeEach(async () => {
  data = await makeTmpDataFolder('atomic-loopback-stream-e2e-')
})
afterEach(async () => {
  for (const daemon of daemons.splice(0)) daemon.kill('SIGKILL')
  await data.cleanup()
})

async function servedLoopback(upstream: string) {
  const { ready } = await core.startDaemon(data.root, daemons)
  const put = await core.control(data.root, ready, '/cloud/providers/loopback-stub', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ base_url: new URL(upstream).origin + '/v1', models: ['loopback-image-repro'] }),
  })
  expect(put.status).toBe(200)
  const started = await core.control(data.root, ready, '/server/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"port":0}',
  })
  expect(started.status).toBe(200)
  const { port } = (await started.json()) as { port: number }
  return (signal: AbortSignal) =>
    fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'loopback-image-repro',
        stream: true,
        messages: [{ role: 'user', content: 'x'.repeat(1_200_000) }],
      }),
    })
}

describe('compiled loopback response streams', () => {
  it('relays every frame and EOF across repeated large requests', async () => {
    const upstream = await delayedSseServer()
    try {
      const post = await servedLoopback(upstream.url)
      for (let turn = 0; turn < 3; turn++) {
        const response = await post(AbortSignal.timeout(5000))
        expect(response.status).toBe(200)
        expect(await response.text()).toBe(upstream.expected)
      }
    } finally {
      await upstream.close()
    }
  })

  it('closes an idle upstream when the client stops after its first frame', async () => {
    const upstream = await delayedSseServer(true)
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const post = await servedLoopback(upstream.url)
      const response = await post(controller.signal)
      const reader = response.body!.getReader()
      expect((await reader.read()).done).toBe(false)
      controller.abort()
      await Promise.race([
        upstream.closed,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('client stop left upstream open')), 2000)
        }),
      ])
      expect(controller.signal.aborted).toBe(true)
    } finally {
      clearTimeout(timer)
      controller.abort()
      await upstream.close()
    }
  })
})
