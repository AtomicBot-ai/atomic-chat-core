/**
 * The managed container runtime through the compiled binary: the routes answer, a setup is recorded
 * durably, the snapshot and the event stream describe the same thing, and a record outlives the core
 * that wrote it.
 *
 * No host recipe is qualified on any platform yet, so every setup here ends in a blocker. That is
 * the point of running it: what a user on an unprepared machine gets is an operation that says why
 * it cannot proceed, not one that appears to be installing something.
 *
 * `ATOMIC_CORE_MANAGED_ROOT` is set for every daemon, so the suite never touches the real per-user
 * environment on the machine it runs on.
 *
 * No imports from `src/`: a packaging change that breaks a route cannot pass by type-checking.
 */
import type { ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as core from '../helpers/compiled-core.js'
import type { ReadyLine } from '../helpers/compiled-core.js'

let dataFolder: string
let managedRoot: string
const daemons: ChildProcess[] = []
const streams: AbortController[] = []

beforeEach(async () => {
  dataFolder = await mkdtemp(join(tmpdir(), 'atomic-core-e2e-managed-'))
  managedRoot = await mkdtemp(join(tmpdir(), 'atomic-managed-e2e-'))
})
afterEach(async () => {
  for (const stream of streams.splice(0)) stream.abort()
  for (const daemon of daemons.splice(0)) daemon.kill('SIGKILL')
  await rm(dataFolder, { recursive: true, force: true, maxRetries: 3 })
  await rm(managedRoot, { recursive: true, force: true, maxRetries: 3 })
})

const start = () => core.startDaemon(dataFolder, daemons, [], { ATOMIC_CORE_MANAGED_ROOT: managedRoot })

const control = (ready: ReadyLine, path: string, init: RequestInit = {}) =>
  core.control(dataFolder, ready, path, init)

const post = (ready: ReadyLine, path: string, body?: unknown) =>
  control(ready, path, {
    method: 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

interface Operation {
  operation_id: string
  request_id: string
  instance_id: string
  phase: string
  error: { code: string; message: string } | null
}

interface Snapshot {
  instance_id: string
  environments: { environment_id: string; executor: string; availability: string }[]
  environment_operations: Operation[]
}

const setup = (requestId = 'req-1') => ({
  request_id: requestId,
  target: { kind: 'environment' as const },
  kind: 'setup' as const,
  descriptor_id: 'trtllm-1.3.0rc27',
})

/** Collects event frames as they arrive, the way the app's relay reads them. */
async function events(ready: ReadyLine): Promise<Array<{ event: string; data: Operation }>> {
  const controller = new AbortController()
  streams.push(controller)
  const res = await control(ready, '/events', { signal: controller.signal })
  const seen: Array<{ event: string; data: Operation }> = []
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
          if (event && data) seen.push({ event, data: JSON.parse(data) as Operation })
        }
      }
    } catch {
      // The stream is aborted in afterEach; that is how it ends.
    }
  })()
  return seen
}

const waitFor = async (check: () => boolean, ms = 5_000): Promise<void> => {
  const deadline = Date.now() + ms
  while (!check() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25))
  expect(check()).toBe(true)
}

/** Read the operation back until it reaches the state under test, or give up loudly. */
async function poll(
  ready: ReadyLine,
  operationId: string,
  done: (operation: Operation) => boolean,
  ms = 5_000
): Promise<Operation> {
  const deadline = Date.now() + ms
  let current = (await (await control(ready, `/environments/operations/${operationId}`)).json()) as Operation
  while (!done(current) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25))
    current = (await (await control(ready, `/environments/operations/${operationId}`)).json()) as Operation
  }
  expect(done(current)).toBe(true)
  return current
}

describe('the managed runtime through the compiled core', () => {
  it('answers the environments route and shows the same thing in the snapshot', async () => {
    const { ready } = await start()

    const listed = (await (await control(ready, '/environments')).json()) as {
      environments: Snapshot['environments']
    }
    const snapshot = (await (await control(ready, '/snapshot')).json()) as Snapshot

    expect(snapshot.environments).toEqual(listed.environments)
    expect(snapshot.environment_operations).toEqual([])
    // Either this platform has an engine it would drive, or it has no environment at all. Nothing
    // is installable yet on any of them, and the answer says so rather than offering a setup.
    for (const environment of listed.environments) {
      expect(['linux-docker', 'wsl-docker']).toContain(environment.executor)
      expect(environment.availability).toBe('unsupported')
    }
  })

  it('records a setup on a machine with no recipe, and says what is missing', async () => {
    const { ready } = await start()
    const started = await post(ready, '/environments/default/operations', setup())
    expect(started.status).toBe(202)
    const operation = (await started.json()) as Operation

    const current = await poll(ready, operation.operation_id, (o) => o.phase === 'failed')

    expect(current.phase).toBe('failed')
    expect(current.error?.code).toBe('MANAGED_PREREQUISITE_BLOCKED')
    // An actionable sentence, not a stack trace: this is what the setup dialog would show.
    expect(current.error?.message).toMatch(/not available on this system/i)
  })

  it('announces every state the operation passes through, as it happens', async () => {
    const { ready } = await start()
    const seen = await events(ready)
    const started = (await (
      await post(ready, '/environments/default/operations', setup())
    ).json()) as Operation

    await waitFor(() => seen.some((frame) => frame.data.phase === 'failed'))
    const mine = seen.filter((frame) => frame.event === 'environment:operation')
    expect(mine.length).toBeGreaterThan(0)
    expect(mine.every((frame) => frame.data.operation_id === started.operation_id)).toBe(true)
  })

  it('hands a retried request the operation it already started', async () => {
    const { ready } = await start()
    const first = (await (await post(ready, '/environments/default/operations', setup())).json()) as Operation
    const again = (await (await post(ready, '/environments/default/operations', setup())).json()) as Operation
    expect(again.operation_id).toBe(first.operation_id)
  })

  it('refuses a body it does not understand before anything is recorded', async () => {
    const { ready } = await start()
    const res = await post(ready, '/environments/default/operations', {
      ...setup(),
      target: { kind: 'runtime' },
    })
    expect(res.status).toBe(400)
    const snapshot = (await (await control(ready, '/snapshot')).json()) as Snapshot
    expect(snapshot.environment_operations).toEqual([])
  })

  it('keeps the record when the core that wrote it is gone', async () => {
    const first = await start()
    const started = (await (
      await post(first.ready, '/environments/default/operations', setup())
    ).json()) as Operation
    await poll(first.ready, started.operation_id, (o) => o.phase === 'failed')

    // The core dies without a chance to tidy up, which is the case the record exists for.
    daemons.splice(0).forEach((daemon) => daemon.kill('SIGKILL'))

    const second = await start()
    expect(second.ready.instance_id).not.toBe(first.ready.instance_id)

    const recovered = (await (
      await control(second.ready, `/environments/operations/${started.operation_id}`)
    ).json()) as Operation
    expect(recovered.operation_id).toBe(started.operation_id)
    expect(recovered.request_id).toBe('req-1')

    // Nothing is in flight any more, and the snapshot belongs to the core answering it.
    const snapshot = (await (await control(second.ready, '/snapshot')).json()) as Snapshot
    expect(snapshot.instance_id).toBe(second.ready.instance_id)
    for (const environment of snapshot.environments) {
      expect(environment.availability).toBe('unsupported')
    }
  })

  it('answers 404 for an operation nobody started', async () => {
    const { ready } = await start()
    expect((await control(ready, '/environments/operations/op-nobody')).status).toBe(404)
  })
})
