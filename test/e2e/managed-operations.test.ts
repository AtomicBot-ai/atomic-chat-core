/**
 * The managed container runtime through the compiled binary (task 2.6): the whole durable setup of
 * the TensorRT-LLM engine on a Linux host, and its removal, driven over the control routes the app
 * and the CLI use.
 *
 * The Linux machine is a folder (`ATOMIC_MANAGED_TEST_HOST`, `test/helpers/fake-managed-host.ts`):
 * fake `docker`, `nvidia-smi`, `systemctl`, ... binaries answering from one state file, a fake Docker
 * Engine API for the pulls, and a fake privileged executor that changes the state the way the recipe
 * would. So this runs the same on macOS, Linux and CI, and nothing here runs a real Docker, a package
 * manager or pkexec. `ATOMIC_CORE_MANAGED_ROOT` keeps the suite off the real per-user environment.
 *
 * The brief's list, one test each: the adopt path; the install path with a relogin; a polkit
 * refusal; `MANAGED_PLAN_CHANGED`; a GPU not visible in a container; a repeated `request_id`; a
 * restart mid-pull (image there → verifying, not there → the pull continues); a receipt with no real
 * result behind it; and a removal while a model container of the engine still runs.
 *
 * No imports from `src/`: a packaging change that breaks a route cannot pass by type-checking.
 */
import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as core from '../helpers/compiled-core.js'
import type { ReadyLine } from '../helpers/compiled-core.js'
import {
  cleanState,
  DESCRIPTOR_ID,
  ENGINE_IMAGE,
  fakeManagedHost,
  GPU_UUID,
  PROBE_IMAGE,
  readyState,
  REQUIRED_DISK_BYTES,
  type FakeManagedHost,
  type PendingHostStep,
} from '../helpers/fake-managed-host.js'

let dataFolder: string
let managedRoot: string
let host: FakeManagedHost | undefined
const daemons: ChildProcess[] = []
const streams: AbortController[] = []

beforeEach(async () => {
  dataFolder = await mkdtemp(join(tmpdir(), 'atomic-core-e2e-managed-'))
  managedRoot = await mkdtemp(join(tmpdir(), 'atomic-managed-e2e-'))
  host = undefined
})
afterEach(async () => {
  for (const stream of streams.splice(0)) stream.abort()
  for (const daemon of daemons.splice(0)) daemon.kill('SIGKILL')
  if (host !== undefined) {
    await host.close()
    await rm(host.dir, { recursive: true, force: true, maxRetries: 3 })
  }
  await rm(dataFolder, { recursive: true, force: true, maxRetries: 3 })
  await rm(managedRoot, { recursive: true, force: true, maxRetries: 3 })
})

const start = (extra: Record<string, string> = {}) =>
  core.startDaemon(dataFolder, daemons, [], {
    ATOMIC_CORE_MANAGED_ROOT: managedRoot,
    ...(host?.env ?? {}),
    ...extra,
  })

/** SIGKILL, the way a crash ends a core: no chance to tidy up. */
const crash = async (): Promise<void> => {
  for (const daemon of daemons.splice(0)) {
    const exited = new Promise((resolve) => daemon.once('exit', resolve))
    daemon.kill('SIGKILL')
    await exited
  }
}

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
  revision: number
  phase: string
  plan_digest: string | null
  approved_plan_digest: string | null
  carried_plan_digest: string | null
  progress: { completed: number | null; total: number | null; unit: string } | null
  pending_host_step: PendingHostStep | null
  error: { code: string; message: string; details?: string } | null
}

interface Environment {
  environment_id: string
  executor: string
  availability: string
  gpus: { gpu_id: string }[]
  installations: { installation_id: string; status: string; active_descriptor_id: string | null }[]
}

interface Snapshot {
  instance_id: string
  environments: Environment[]
  environment_operations: Operation[]
}

const TARGET = { kind: 'runtime' as const, installation_id: 'tensorrt-llm', engine_id: 'tensorrt-llm' }

const setup = (requestId = 'req-1', extra: Record<string, unknown> = {}) => ({
  request_id: requestId,
  target: TARGET,
  kind: 'setup' as const,
  descriptor_id: DESCRIPTOR_ID,
  ...extra,
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

const get = async (ready: ReadyLine, operationId: string): Promise<Operation> =>
  (await (await control(ready, `/environments/operations/${operationId}`)).json()) as Operation

/** Read the operation back until it reaches the state under test, or give up loudly. */
async function poll(
  ready: ReadyLine,
  operationId: string,
  done: (operation: Operation) => boolean,
  ms = 15_000
): Promise<Operation> {
  const deadline = Date.now() + ms
  let current = await get(ready, operationId)
  while (!done(current) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50))
    current = await get(ready, operationId)
  }
  expect(done(current), `stuck at ${current.phase}: ${JSON.stringify(current.error)}`).toBe(true)
  return current
}

/**
 * Wait until the event stream has delivered a frame the test needs (final review T-312): reading the
 * operation back can see a phase before the SSE stream has carried the event that announced it.
 */
async function frame(
  seen: Array<{ event: string; data: Operation }>,
  match: (frame: { event: string; data: Operation }) => boolean,
  ms = 5_000
): Promise<void> {
  const deadline = Date.now() + ms
  while (!seen.some(match) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
  expect(seen.some(match), 'the event stream never delivered the frame').toBe(true)
}

const settled = (operation: Operation): boolean =>
  [
    'awaiting-consent',
    'preparing-host',
    'relogin-required',
    'ready',
    'removed',
    'failed',
    'cancelled',
  ].includes(operation.phase) &&
  // `preparing-host` counts only once the step is out.
  (operation.phase !== 'preparing-host' || operation.pending_host_step !== null)

/** Begin, wait for the plan, approve it: the consent a user gives in the setup dialog. */
async function beginAndApprove(ready: ReadyLine, requestId = 'req-1'): Promise<Operation> {
  const started = (await (
    await post(ready, '/environments/default/operations', setup(requestId))
  ).json()) as Operation
  const asking = await poll(ready, started.operation_id, (o) => o.phase === 'awaiting-consent')
  expect(asking.plan_digest).toMatch(/^sha256:/)
  const approved = await post(ready, `/environments/operations/${started.operation_id}/resume`, {
    expected_revision: asking.revision,
    approved_plan_digest: asking.plan_digest,
  })
  expect(approved.status).toBe(200)
  return asking
}

const snapshot = async (ready: ReadyLine): Promise<Snapshot> =>
  (await (await control(ready, '/snapshot')).json()) as Snapshot

describe('setting up the managed engine through the compiled core (task 2.6)', () => {
  it('adopts a ready host: consent, GPU check, byte-progress pull, verification, activation', async () => {
    host = await fakeManagedHost(readyState())
    const { ready } = await start()
    const seen = await events(ready)

    const probe = (await (
      await post(ready, '/environments/probe', { descriptor_id: DESCRIPTOR_ID, target: TARGET })
    ).json()) as { adopts_existing_engine: boolean; system_changes: unknown[]; requires_elevation: boolean }
    expect(probe).toMatchObject({
      adopts_existing_engine: true,
      system_changes: [],
      requires_elevation: false,
    })

    const asking = await beginAndApprove(ready)
    const done = await poll(ready, asking.operation_id, (o) => o.phase === 'ready' || o.phase === 'failed')
    expect(done.phase).toBe('ready')
    await frame(
      seen,
      (f) =>
        f.event === 'environment:operation' &&
        f.data.operation_id === asking.operation_id &&
        f.data.phase === 'ready'
    )

    const phases = seen
      .filter((frame) => frame.event === 'environment:operation')
      .map((frame) => frame.data.phase)
      .filter((phase, index, all) => phase !== all[index - 1])
    expect(phases).toEqual([
      'checking',
      'awaiting-consent',
      'checking',
      'preparing-environment',
      'pulling-image',
      'verifying',
      'activating',
      'ready',
    ])
    // Byte progress while pulling, measured against the descriptor's download size.
    const progress = seen
      .map((frame) => frame.data.progress)
      .filter((tick): tick is NonNullable<Operation['progress']> => tick !== null && tick !== undefined)
    expect(progress.length).toBeGreaterThan(0)
    expect(progress.every((tick) => tick.unit === 'bytes')).toBe(true)
    expect(progress.some((tick) => (tick.completed ?? 0) > 0)).toBe(true)

    // The GPU check ran on the card, from the probe image, before the engine image was pulled.
    expect(host.pulls).toEqual([PROBE_IMAGE, ENGINE_IMAGE])
    const run = host.calls().find((call) => call[0] === 'docker' && call[3] === 'run')
    expect(run).toContain(`device=${GPU_UUID}`)
    expect(run).toContain(PROBE_IMAGE)

    // Installed, on a disk the image has now nearly filled: still supported, never disk-blocked.
    const after = (await (
      await post(ready, '/environments/probe', { descriptor_id: DESCRIPTOR_ID, target: TARGET })
    ).json()) as { availability: string; blockers: unknown[] }
    expect(after).toMatchObject({ availability: 'supported', blockers: [] })
    const environment = (await snapshot(ready)).environments[0]
    expect(environment?.availability).toBe('supported')
    expect(environment?.gpus.map((gpu) => gpu.gpu_id)).toEqual([GPU_UUID])
    expect(environment?.installations).toEqual([
      expect.objectContaining({
        installation_id: 'tensorrt-llm',
        status: 'ready',
        active_descriptor_id: DESCRIPTOR_ID,
      }),
    ])
  })

  it('installs Docker with one privileged step, waits for the sign-in, and continues at the next start', async () => {
    host = await fakeManagedHost(cleanState())
    const first = await start()
    const asking = await beginAndApprove(first.ready)
    const waiting = await poll(first.ready, asking.operation_id, settled)
    expect(waiting.phase).toBe('preparing-host')
    const step = waiting.pending_host_step as PendingHostStep
    // The step carries the recipe's validated parameters, which the client copies into the request.
    expect(step.parameters.components).toEqual([
      'docker-engine',
      'nvidia-container-toolkit',
      'nvidia-runtime',
      'docker-service',
      'docker-group',
    ])
    expect(host.pulls).toEqual([])

    const receipt = host.runHostStep(step, 'completed')
    expect(
      (await post(first.ready, `/environments/operations/${asking.operation_id}/host-step-result`, receipt))
        .status
    ).toBe(200)
    const relogin = await poll(first.ready, asking.operation_id, settled)
    expect(relogin.phase).toBe('relogin-required')
    expect(relogin.error?.code).toBe('MANAGED_RELOGIN_REQUIRED')

    // The nonce is spent: the same receipt again, or another outcome for it, is refused.
    const again = await post(
      first.ready,
      `/environments/operations/${asking.operation_id}/host-step-result`,
      receipt
    )
    expect(again.status).toBe(409)
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe('MANAGED_RECEIPT_CONFLICT')
    const replay = await post(
      first.ready,
      `/environments/operations/${asking.operation_id}/host-step-result`,
      {
        ...receipt,
        outcome: 'failed',
      }
    )
    expect(replay.status).toBe(409)
    expect(((await replay.json()) as { error: { code: string } }).error.code).toBe('MANAGED_RECEIPT_CONFLICT')

    // The user signs out and back in: the group is in the session, and the app opens again.
    await crash()
    host.update((state) => ({
      ...state,
      group: { configured: true, effective: true },
      docker: { ...state.docker, reachable: true },
    }))
    const second = await start()
    const done = await poll(
      second.ready,
      asking.operation_id,
      (o) => o.phase === 'ready' || o.phase === 'failed' || o.phase === 'awaiting-consent'
    )
    // Continued on its own, without asking again for what was already approved and done.
    expect(done.phase).toBe('ready')
    // The consented plan stays the plan on the wire; the re-probed one is reported apart.
    expect(done.plan_digest).toBe(done.approved_plan_digest)
    expect(done.carried_plan_digest).toMatch(/^sha256:/)
    expect(done.carried_plan_digest).not.toBe(done.plan_digest)
    expect(host.calls().filter((call) => call[0] === 'host-step')).toHaveLength(1)
    expect(host.pulls).toEqual([PROBE_IMAGE, ENGINE_IMAGE])
  })

  it('keeps a refused system prompt resumable, with nothing changed on the host', async () => {
    host = await fakeManagedHost(cleanState())
    const { ready } = await start()
    const asking = await beginAndApprove(ready)
    const waiting = await poll(ready, asking.operation_id, settled)
    const step = waiting.pending_host_step as PendingHostStep

    await post(
      ready,
      `/environments/operations/${asking.operation_id}/host-step-result`,
      host.runHostStep(step, 'declined')
    )
    const declined = await poll(ready, asking.operation_id, settled)
    expect(declined.phase).toBe('failed')
    expect(declined.error?.code).toBe('MANAGED_ELEVATION_DECLINED')
    expect(host.state()).toEqual(cleanState())

    // Resumable: the same approved plan issues a fresh step with a new nonce.
    await post(ready, `/environments/operations/${asking.operation_id}/resume`, {
      expected_revision: declined.revision,
    })
    const again = await poll(ready, asking.operation_id, settled)
    expect(again.phase).toBe('preparing-host')
    expect(again.pending_host_step?.nonce).not.toBe(step.nonce)
  })

  it('refuses a consent given for a plan the host has outgrown (MANAGED_PLAN_CHANGED)', async () => {
    host = await fakeManagedHost(readyState())
    const { ready } = await start()
    const started = (await (
      await post(ready, '/environments/default/operations', setup())
    ).json()) as Operation
    const asking = await poll(ready, started.operation_id, (o) => o.phase === 'awaiting-consent')

    // Between the probe and the click, a second card appeared.
    host.update((state) => ({
      ...state,
      gpus: [
        ...(state.gpus ?? []),
        { uuid: 'GPU-second', name: 'NVIDIA RTX A6000', cc: '8.6', total_mib: 49140, free_mib: 49000 },
      ],
    }))
    await post(ready, `/environments/operations/${started.operation_id}/resume`, {
      expected_revision: asking.revision,
      approved_plan_digest: asking.plan_digest,
    })
    const changed = await poll(
      ready,
      started.operation_id,
      (o) => o.revision > asking.revision + 1 && settled(o)
    )
    expect(changed.phase).toBe('awaiting-consent')
    expect(changed.error?.code).toBe('MANAGED_PLAN_CHANGED')
    expect(changed.plan_digest).not.toBe(asking.plan_digest)
    expect(host.pulls).toEqual([])
  })

  it('fails with toolkit diagnostics when the GPU is not visible in a container, and pulls no engine image', async () => {
    host = await fakeManagedHost({ ...readyState(), gpu_visible_in_container: false })
    const { ready } = await start()
    const asking = await beginAndApprove(ready)
    const failed = await poll(ready, asking.operation_id, settled)
    expect(failed.phase).toBe('failed')
    expect(failed.error?.code).toBe('MANAGED_PREREQUISITE_BLOCKED')
    expect(failed.error?.message).toMatch(/not visible inside a container/)
    expect(failed.error?.details).toContain(`gpu=${GPU_UUID}`)
    expect(failed.error?.details).toContain('could not select device driver')
    expect(host.pulls).toEqual([PROBE_IMAGE])
  })

  it('hands a retried request the operation it already started, and refuses the id for another one', async () => {
    host = await fakeManagedHost(readyState())
    const { ready } = await start()
    const first = (await (await post(ready, '/environments/default/operations', setup())).json()) as Operation
    const again = (await (await post(ready, '/environments/default/operations', setup())).json()) as Operation
    expect(again.operation_id).toBe(first.operation_id)
    const other = await post(ready, '/environments/default/operations', setup('req-1', { kind: 'remove' }))
    expect(other.status).toBe(409)
    expect((await snapshot(ready)).environment_operations).toHaveLength(1)
  })

  it('picks a pull back up after a crash: verifying when the image is there, pulling on when it is not', async () => {
    for (const imageLanded of [true, false]) {
      host = await fakeManagedHost(readyState())
      host.holdEnginePull = true
      const first = await start()
      const asking = await beginAndApprove(first.ready)
      const pulling = await poll(
        first.ready,
        asking.operation_id,
        (o) => o.phase === 'pulling-image' && (o.progress?.completed ?? 0) > 0
      )
      expect(pulling.progress?.unit).toBe('bytes')

      await crash()
      host.holdEnginePull = false
      // Either way, less than the whole image's requirement is free now: half or all of it is on disk.
      if (imageLanded) host.landEngineImage()
      const pullsBefore = host.pulls.length
      const second = await start()
      const done = await poll(
        second.ready,
        asking.operation_id,
        (o) => o.phase === 'ready' || o.phase === 'failed' || o.phase === 'awaiting-consent'
      )
      expect(done.phase).toBe('ready')
      // No new consent, no second GPU check; the engine image pulled again only when it was missing.
      expect(host.pulls.slice(pullsBefore)).toEqual(imageLanded ? [] : [ENGINE_IMAGE])
      // The GPU-check image was pulled by the first core, which died before activating: the second
      // core still knows it was this setup's own, because that was recorded before the pull.
      const installation = JSON.parse(
        await readFile(join(managedRoot, 'installations', 'tensorrt-llm', 'installation.json'), 'utf8')
      ) as { probe_image?: { repository: string; digest: string } }
      expect(`${installation.probe_image?.repository}@${installation.probe_image?.digest}`).toBe(PROBE_IMAGE)

      await crash()
      await host.close()
      await rm(host.dir, { recursive: true, force: true })
      host = undefined
      await rm(managedRoot, { recursive: true, force: true })
      await mkdir(managedRoot, { recursive: true })
    }
  })

  it('refuses a setup the free space cannot hold, before anything is pulled', async () => {
    host = await fakeManagedHost(readyState())
    host.setFreeDisk(REQUIRED_DISK_BYTES - 1)
    const { ready } = await start()
    const started = (await (
      await post(ready, '/environments/default/operations', setup())
    ).json()) as Operation
    const failed = await poll(ready, started.operation_id, settled)
    expect(failed.phase).toBe('failed')
    expect(failed.error?.details).toBe('insufficient-disk')
    expect(host.pulls).toEqual([])
  })

  it('fails with what the machine shows when the helper reports success it did not have', async () => {
    host = await fakeManagedHost(cleanState())
    const { ready } = await start()
    const asking = await beginAndApprove(ready)
    const waiting = await poll(ready, asking.operation_id, settled)
    const receipt = host.runHostStep(waiting.pending_host_step as PendingHostStep, 'completed', 'none')

    await post(ready, `/environments/operations/${asking.operation_id}/host-step-result`, receipt)
    const failed = await poll(ready, asking.operation_id, settled)
    // The probe after the receipt still finds no Docker: a failure with that result, not a relogin.
    expect(failed.phase).toBe('failed')
    expect(failed.error?.code).toBe('MANAGED_PREREQUISITE_BLOCKED')
    expect(failed.error?.message).toMatch(/still needs/)
    expect(host.pulls).toEqual([])
  })
})

describe('removing the managed engine through the compiled core (task 2.6)', () => {
  it('stops the engine’s running container first, then removes the image and caches; models and Docker stay', async () => {
    host = await fakeManagedHost({ ...readyState(), images: ['docker.io/library/postgres@sha256:beef'] })
    const first = await start()
    const setupOp = await beginAndApprove(first.ready)
    expect(
      (await poll(first.ready, setupOp.operation_id, (o) => o.phase === 'ready' || o.phase === 'failed'))
        .phase
    ).toBe('ready')
    await crash()

    // A model container of this engine that is still running (its stop was not confirmed when the
    // core restarted, so the startup reconcile left it and its journal record alone), the engine's
    // cache, a downloaded model, and a container of someone else's.
    const executions = join(dataFolder, 'atomic-core', 'managed-runtimes', 'executions')
    await mkdir(executions, { recursive: true })
    await writeFile(
      join(executions, 'trt-running.json'),
      JSON.stringify({
        container_id: 'trt-running',
        engine_id: 'tensorrt-llm',
        image_digest: ENGINE_IMAGE.split('@')[1],
        scope: 'cli',
        instance_id: 'previous-core',
        created_at: '2026-09-29T00:00:00.000Z',
      })
    )
    host.update((state) => ({
      ...state,
      containers: [
        { id: 'trt-running', image: ENGINE_IMAGE, running: true },
        { id: 'their-db', image: 'docker.io/library/postgres@sha256:beef', running: true },
      ],
      stop_refusals: 1,
    }))
    const cache = join(dataFolder, 'atomic-core', 'managed-runtimes', 'caches', DESCRIPTOR_ID, 'some-model')
    await mkdir(cache, { recursive: true })
    const model = join(dataFolder, 'tensorrt-llm', 'models', 'some-model')
    await mkdir(model, { recursive: true })

    const second = await start()
    const started = (await (
      await post(second.ready, '/environments/default/operations', {
        request_id: 'rm-1',
        target: TARGET,
        kind: 'remove',
      })
    ).json()) as Operation
    const asking = await poll(second.ready, started.operation_id, (o) => o.phase === 'awaiting-consent')
    await post(second.ready, `/environments/operations/${started.operation_id}/resume`, {
      expected_revision: asking.revision,
      approved_plan_digest: asking.plan_digest,
    })
    const removed = await poll(
      second.ready,
      started.operation_id,
      (o) => o.phase === 'removed' || o.phase === 'failed'
    )
    expect(removed.phase).toBe('removed')

    const docker = host.calls().filter((call) => call[0] === 'docker' && call[1] === '--host')
    const stop = docker.findIndex((call) => call[3] === 'stop' && call.includes('trt-running'))
    const imageRm = docker.findIndex((call) => call[3] === 'image' && call[4] === 'rm')
    expect(stop).toBeGreaterThanOrEqual(0)
    expect(imageRm).toBeGreaterThan(stop)
    expect(docker[imageRm]).toContain(ENGINE_IMAGE)
    // Our container and both our images (the engine's and the GPU check's) are gone; someone
    // else's container and image are exactly as they were.
    expect(host.state().containers?.map((c) => c.id)).toEqual(['their-db'])
    expect(host.state().images).toEqual(['docker.io/library/postgres@sha256:beef'])
    expect(docker.some((call) => call[3] === 'image' && call[4] === 'rm' && call.includes(PROBE_IMAGE))).toBe(
      true
    )
    expect(docker.some((call) => call.includes('their-db'))).toBe(false)
    // The caches are gone, the downloaded model stays, and nothing reached for Docker itself.
    expect(existsSync(cache)).toBe(false)
    expect(existsSync(model)).toBe(true)
    expect(await readdir(executions)).toEqual([])
    expect(host.calls().some((call) => call[0] === 'host-step')).toBe(false)

    const environment = (await snapshot(second.ready)).environments[0]
    expect(environment?.installations).toEqual([])
    expect(environment?.availability).toBe('setup-required')
  })
})

describe('an image the user already had', () => {
  it('is never removed with the installation: the GPU-check image was not this setup’s to remove', async () => {
    host = await fakeManagedHost({ ...readyState(), images: [PROBE_IMAGE] })
    const { ready } = await start()
    const setupOp = await beginAndApprove(ready)
    expect(
      (await poll(ready, setupOp.operation_id, (o) => o.phase === 'ready' || o.phase === 'failed')).phase
    ).toBe('ready')

    const started = (await (
      await post(ready, '/environments/default/operations', {
        request_id: 'rm-1',
        target: TARGET,
        kind: 'remove',
      })
    ).json()) as Operation
    const asking = await poll(ready, started.operation_id, (o) => o.phase === 'awaiting-consent')
    await post(ready, `/environments/operations/${started.operation_id}/resume`, {
      expected_revision: asking.revision,
      approved_plan_digest: asking.plan_digest,
    })
    expect(
      (await poll(ready, started.operation_id, (o) => o.phase === 'removed' || o.phase === 'failed')).phase
    ).toBe('removed')
    expect(host.state().images).toEqual([PROBE_IMAGE])
  })
})

describe('without a Linux host', () => {
  it.skipIf(process.platform === 'linux')(
    'offers no environment, and a setup says what is missing',
    async () => {
      const { ready } = await start()
      const snap = await snapshot(ready)
      expect(snap.environments).toEqual([])
      const started = await post(ready, '/environments/default/operations', setup())
      expect(started.status).toBe(202)
      const operation = (await started.json()) as Operation
      const current = await poll(ready, operation.operation_id, (o) => o.phase === 'failed')
      expect(current.error?.code).toBe('MANAGED_PREREQUISITE_BLOCKED')
      expect(current.error?.message).toMatch(/not available on this system/i)
    }
  )

  it('refuses a body it does not understand before anything is recorded', async () => {
    host = await fakeManagedHost(readyState())
    const { ready } = await start()
    const res = await post(ready, '/environments/default/operations', {
      ...setup(),
      target: { kind: 'runtime' },
    })
    expect(res.status).toBe(400)
    expect((await snapshot(ready)).environment_operations).toEqual([])
  })

  it('answers 404 for an operation nobody started', async () => {
    host = await fakeManagedHost(readyState())
    const { ready } = await start()
    expect((await control(ready, '/environments/operations/op-nobody')).status).toBe(404)
  })
})
