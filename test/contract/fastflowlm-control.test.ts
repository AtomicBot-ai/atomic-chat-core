import { installFakeBackend } from '../helpers/fake-backend-pack.js'
import windowsXrt from '../fixtures/fastflowlm/windows-xrt-pci.json' with { type: 'json' }
import { nodeLauncher } from '../helpers/engine-builds-mirror.js'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { CoreClient, fastFlowLmSources, parseFastFlowLmDescriptor } from '../../src/client/index.js'
import {
  ERROR_CODES,
  FASTFLOWLM_OPERATION_STATES,
  MANAGED_HOST_ACTIONS,
  AtomicCoreError,
  type CoreEvents,
  type FastFlowLmOperation,
  type FastFlowLmMaintenance,
  type FastFlowLmPreparationPlan,
  type ManagedHostReceipt,
  type FastFlowLmHostStep,
  type Sha256Digest,
} from '../../src/contracts/index.js'
import { canonicalDigest } from '../../src/runtime/environment/index.js'
import { CoreEmitter } from '../../src/events/index.js'
import { sseFrame } from '../../src/server/control/routes/lifecycle.js'
import { statusForCode } from '../../src/server/http.js'
import { createCore, data, useCoreHarness } from '../helpers/core-harness.js'
import { windowsManifest } from '../helpers/flm-environment.js'
import { flmRelease } from '../helpers/fastflowlm-manifest.js'
import { linuxFastFlowLmPci, writeFlmInstallation } from '../helpers/fastflowlm-installation.js'
import relay from '../fixtures/fastflowlm/relay-event.json' with { type: 'json' }
import wire from '../fixtures/fastflowlm/control-v1.json' with { type: 'json' }
import candidate from '../fixtures/fastflowlm/qwen3-candidate.json' with { type: 'json' }

// JSON imports widen string literals. Narrow the fixture's discriminants and digests before
// passing it to the public types, so adding a required field breaks this consumer at typecheck.
function digest(value: string): Sha256Digest {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) throw new Error('Invalid test digest')
  return value as Sha256Digest
}
function example<const T extends string | boolean>(actual: string | boolean, expected: T): T {
  expect(actual).toBe(expected)
  return expected
}
const plan = {
  ...wire.operation.plan,
  runtime_mode: example(wire.operation.plan.runtime_mode, 'system-service'),
  plan_digest: digest(wire.operation.plan.plan_digest),
  manifest_digest: digest(wire.operation.plan.manifest_digest),
  recipe_digest: digest(wire.operation.plan.recipe_digest),
} satisfies FastFlowLmPreparationPlan
const pending = wire.operation.pending_host_step
const hostStep = {
  ...pending,
  action: example(pending.action, 'linux.install-amd-npu'),
  recipe_digest: digest(pending.recipe_digest),
  parameters_digest: digest(pending.parameters_digest),
  parameters: {
    ...pending.parameters,
    runtime_mode: example(pending.parameters.runtime_mode, 'system-service'),
    manifest_digest: digest(pending.parameters.manifest_digest),
  },
} satisfies FastFlowLmHostStep
const operation = {
  ...wire.operation,
  plan,
  pending_host_step: hostStep,
  state: example(wire.operation.state, 'preparing-host'),
} satisfies FastFlowLmOperation
const awaiting = {
  ...operation,
  state: 'awaiting-consent',
  revision: 2,
  pending_host_step: null,
} satisfies FastFlowLmOperation

describe('FLM control wire from the authenticated owner', () => {
  useCoreHarness()
  it('returns the driverless Windows PnP device through the SDK before engine installation', async () => {
    const environment = join(data.root, 'environment.json')
    const builds = join(data.root, 'builds.json')
    await writeFile(builds, JSON.stringify({ schema_version: 1, releases: [flmRelease(2)] }))
    const core = await createCore({
      env: {
        ATOMIC_FASTFLOWLM_ENVIRONMENT_MANIFEST_URL: pathToFileURL(environment).href,
        ATOMIC_FASTFLOWLM_MANIFEST_URL: pathToFileURL(builds).href,
      },
      platform: 'win32',
      foundryLocalHost: { arch: 'x64', osRelease: '10.0.22631' },
      hardware: {
        fastFlowLm: {
          run: async (_file, args) => ({
            code: 0,
            stderr: '',
            stdout: args.at(-1)?.endsWith('.ProductType')
              ? '1'
              : JSON.stringify({
                  account: 'HOST\\user',
                  elevated: false,
                  session: 1,
                  service: null,
                  devices: [
                    {
                      id: 'PCI\\VEN_1022&DEV_17F0&SUBSYS_513717AA&REV_20\\4',
                      bdf: '0000:c4:00.1',
                      problem: 28,
                      version: null,
                    },
                  ],
                }),
          }),
        },
      },
    })
    const client = new CoreClient({ baseUrl: core.control.url, token: core.controlToken })
    expect(await client.fastFlowLmAccelerators()).toEqual(wire.accelerators)
    const manual = {
      status: 'blocked',
      packages: [],
      changes: [],
      recipe_id: null,
      blockers: expect.arrayContaining(['driver-missing']),
      driver_setup: {
        commands: [],
        links: [
          { label: 'AMD driver downloads', url: 'https://www.amd.com/en/support/download/drivers.html' },
        ],
      },
    }
    expect(await client.probeFastFlowLm()).toMatchObject(manual)
    await writeFile(environment, JSON.stringify(windowsManifest()))
    expect(await client.probeFastFlowLm()).toMatchObject(manual)
    expect((await client.fastFlowLmAccelerators()).automatic_repair_available).toBe(false)
    const operation = await client.beginFastFlowLmOperation({ request_id: 'windows-driver' })
    expect(operation).toMatchObject({
      state: 'failed',
      pending_host_step: null,
      plan: { packages: [], changes: [] },
    })
    expect(await client.fastFlowLmOperations()).toEqual([operation])

    // A previous release may have already approved a driver operation before this policy changed.
    const journal = join(data.root, 'fastflowlm/runtime/operations', operation.operation_id + '.json')
    const saved = JSON.parse(await readFile(journal, 'utf8'))
    saved.record.approvedManifest = windowsManifest()
    saved.record.build = 'flm-1.0.11-r2'
    saved.record.operation.plan.manifest_digest = canonicalDigest(saved.record.approvedManifest)
    saved.record.operation.plan.recipe_digest = canonicalDigest(saved.record.approvedManifest.recipes[0])
    await writeFile(journal, JSON.stringify({ ...saved, digest: canonicalDigest(saved.record) }))
    const resumed = await client.resumeFastFlowLmOperation(operation.operation_id, operation.revision)
    expect(resumed.state).toBe('awaiting-consent')
    expect(resumed.plan.packages[0]?.version).toBe('32.0.203.314')
    const approved = await client.consentFastFlowLmOperation(resumed.operation_id, {
      expected_revision: resumed.revision,
      approved_plan_digest: resumed.plan.plan_digest,
    })
    const claimed = await client.claimFastFlowLmHostStep(approved.operation_id, approved.revision)
    expect(claimed.pending_host_step?.action).toBe('windows.install-amd-npu')
    const step = claimed.pending_host_step!
    await client.cancelFastFlowLmOperation(claimed.operation_id)
    expect(
      (
        await client.submitFastFlowLmHostReceipt(claimed.operation_id, {
          receipt_id: 'declined',
          nonce: step.nonce,
          step_id: step.step_id,
          expected_operation_revision: step.expected_operation_revision,
          recipe_digest: step.recipe_digest,
          parameters_digest: step.parameters_digest,
          outcome: 'declined',
        })
      ).state
    ).toBe('cancelled')
  })

  it.skipIf(process.platform === 'win32')(
    'routes public chat to the installed checkpoint and blocks load until client removal completes',
    async () => {
      const build = flmRelease(2),
        platform = 'win-x64-npu',
        folder = join(data.root, 'fastflowlm', 'backends', build.version, platform)
      await mkdir(folder, { recursive: true })
      await writeFile(join(folder, '.atomic-owned'), 'atomic-chat')
      await writeFile(
        join(folder, 'install.json'),
        JSON.stringify({
          tag: build.version,
          backendId: platform,
          atomic_revision: 2,
          local_only_protocol: 1,
          upstream_commit: build.upstream_commit,
          sha256: build.assets[0]!.sha256,
          installedAtMs: 1,
        })
      )
      await writeFile(
        join(folder, 'flm.exe'),
        '#!/bin/sh\n: > ready\n' + nodeLauncher(resolve('test/helpers/fake-fastflowlm.mjs'), {}),
        { mode: 0o700 }
      )
      const { dir, metadata } = await writeFlmInstallation(data.root)
      const core = await createCore({
        platform: 'win32',
        foundryLocalHost: { arch: 'x64', osRelease: '10.0.22631' },
        hardware: {
          fastFlowLm: {
            run: async (_exe, args) => {
              const out =
                args[0] === '-NoProfile'
                  ? {
                      account: 'HOST\\user',
                      elevated: false,
                      session: 1,
                      service: null,
                      devices: [
                        {
                          id: 'PCI\\VEN_1022&DEV_17F0&SUBSYS_513717AA&REV_20\\3',
                          bdf: '0000:c4:00.1',
                          problem: 0,
                          version: '32.0.203.329',
                        },
                      ],
                    }
                  : args[0] === 'atomic-capabilities'
                    ? { environment_probe_protocol: 1 }
                    : args[0] === 'atomic-validate'
                      ? {
                          object: 'npu_stack_validation',
                          platform: 'windows',
                          amd_device_found: true,
                          npu_driver_ok: true,
                          npu_platform: 'aie2p',
                          ready: true,
                        }
                      : windowsXrt
              return { stdout: JSON.stringify(out), stderr: '', code: 0 }
            },
          },
        },
      })
      const client = new CoreClient({ baseUrl: core.control.url, token: core.controlToken }),
        id = metadata.variant_id
      const gpuPack = await installFakeBackend(data.layout, { gpu: true, backend: 'win-avx2-x64-cuda-cu12' })
      await data.writeModel('gpu-model')
      const gpu = await core.load('llamacpp-upstream', 'gpu-model', {
        exePath: gpuPack.exePath,
        versionBackend: gpuPack.versionBackend,
        timeoutSecs: 5,
      })
      expect(core.runtime('llamacpp-upstream').gpuOccupancy?.()).toMatchObject([
        { model_id: 'gpu-model', cards: 'all', state: 'ready' },
      ])
      await core.load('fastflowlm', id, { timeoutSecs: 5 })
      expect(core.runtime('llamacpp-upstream').list()[0]?.pid).toBe(gpu.pid)
      const { port } = await core.startPublicServer({ port: 0 })
      const response = await fetch('http://127.0.0.1:' + port + '/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: id, messages: [{ role: 'user', content: 'hello' }] }),
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ model: id, usage: { completion_tokens: 1 } })
      // A duplicate load and maintenance compete for the same runtime lock. Either load wins
      // before begin, or it observes the durable guard; neither may outlive ready_to_mutate.
      const competingLoad = core.load('fastflowlm', id).catch((error: unknown) => error)
      const guard = await client.beginFastFlowLmMaintenance({
        request_id: 'rm-1',
        model_id: id,
        kind: 'remove',
      })
      await competingLoad
      expect(core.runtime('fastflowlm').list()).toEqual([])
      expect(core.runtime('llamacpp-upstream').list()[0]?.pid).toBe(gpu.pid)
      const gpuChat = await fetch('http://127.0.0.1:' + port + '/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpu-model', messages: [{ role: 'user', content: 'Still running?' }] }),
      })
      expect(gpuChat.status).toBe(200)
      expect(await gpuChat.json()).toMatchObject({ choices: [{ message: { content: expect.any(String) } }] })
      expect(guard.ready_to_mutate).toBe(true)
      await expect(core.load('fastflowlm', id)).rejects.toMatchObject({ code: 'MANAGED_OPERATION_CONFLICT' })
      await rm(dir, { recursive: true })
      expect(await client.completeFastFlowLmMaintenance(guard.operation_id)).toMatchObject({
        state: 'completed',
      })
      await expect(core.load('fastflowlm', id)).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND' })
    }
  )
  it('checks the catalog and both installed lookup forms, and exposes the core-selected build through the existing lifecycle', async () => {
    const manifest = join(data.root, 'flm-builds.json')
    await writeFile(manifest, JSON.stringify({ schema_version: 1, releases: [flmRelease()] }))
    const core = await createCore({
      platform: 'linux',
      hardware: { fastFlowLm: { fs: linuxFastFlowLmPci() } },
      foundryLocalHost: { arch: 'x64', glibcVersion: '2.39' },
      env: { ATOMIC_FASTFLOWLM_MANIFEST_URL: pathToFileURL(manifest).href },
      fetch: async () => new Response(null, { status: 404 }),
    })
    const client = new CoreClient({ baseUrl: core.control.url, token: core.controlToken })
    const check = await client.checkFastFlowLmModel({
      descriptor: parseFastFlowLmDescriptor(candidate.definition),
    })
    expect(check).toMatchObject({ ...wire.check, reason: expect.any(String) })
    const { dir, metadata } = await writeFlmInstallation(data.root)
    for (const request of [{ model_id: metadata.variant_id }, { path: dir }])
      expect(await client.checkFastFlowLmModel(request)).toMatchObject({ ...check, metadata })
    const { engines } = await client.engineVersions()
    expect(engines.find((e) => e.engine === 'fastflowlm')).toMatchObject(wire.versions)
    expect(engines.find((e) => e.engine === 'llamacpp')).toMatchObject({
      kind: 'llamacpp',
      active_choice: 'client',
    })
    await expect(
      client.updateEngine('fastflowlm', { task_id: 'test', target: { variant: 'manual' } })
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(
      client.activateEngineBuild('fastflowlm', 'flm-1.0.11-r1', 'linux-x64-npu')
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })
})
it('maps provider failures to control HTTP status and preserves their error envelope through the client', async () => {
  const codes = ERROR_CODES.filter((c) => c.startsWith('FASTFLOWLM_'))
  expect(codes.toSorted()).toEqual(Object.keys(wire.errors).sort())
  for (const code of codes) {
    const status = statusForCode(code)
    expect(status, code).toBe(wire.errors[code as keyof typeof wire.errors])
    const error = new AtomicCoreError(code, 'Diagnostic', 'device-1')
    const client = new CoreClient({
      baseUrl: 'http://fixture',
      token: 'token',
      fetch: async () => Response.json({ error: error.toJSON() }, { status }),
    })
    await expect(client.fastFlowLmAccelerators()).rejects.toMatchObject({
      code,
      message: 'Diagnostic',
      details: 'device-1',
    })
  }
})
it('keeps the operation snapshot identical across SSE, GET and the preparation client', async () => {
  expectTypeOf<CoreEvents['fastflowlm:operation']>().toEqualTypeOf<FastFlowLmOperation>()
  expectTypeOf<FastFlowLmPreparationPlan['packages'][number]>().toEqualTypeOf<{
    name: string
    version: string
    source: string
    sha256: string
  }>()
  expectTypeOf<FastFlowLmMaintenance['state']>().toEqualTypeOf<'stopping' | 'held' | 'completed'>()
  expect(FASTFLOWLM_OPERATION_STATES).toEqual(wire.states)
  const emitter = new CoreEmitter({ instanceId: 'owner' })
  const event = emitter.emit('fastflowlm:operation', operation)
  const path = '/atomic/v1/runtimes/fastflowlm'
  const client = new CoreClient({
    baseUrl: 'http://fixture',
    token: 'token',
    fetch: async (url, init) => {
      const route = new URL(String(url)).pathname
      if (route === '/atomic/v1/events')
        return new Response(sseFrame(emitter.cursor(event.seq), event.name, event.payload))
      if (route === path + '/accelerators') return Response.json(wire.accelerators)
      if (route === path + '/probe') return Response.json(wire.operation.plan)
      if (route === path + '/operations' && !init?.method) return Response.json([wire.operation])
      if (route === path + '/operations/operation-1') return Response.json(wire.operation)
      throw Error('Unexpected request ' + route)
    },
  })
  const messages: unknown[] = []
  await client.events((m) => messages.push(m))
  const recovered = await client.fastFlowLmOperation('operation-1')
  expect(messages).toEqual([{ id: relay.id, event: relay.event, data: relay.data }])
  expect('atomic-core://' + event.name).toBe(relay.desktop_event)
  expect(recovered).toEqual(relay.data)
  expect(await client.fastFlowLmOperations()).toEqual([recovered])
  expect(await client.fastFlowLmAccelerators()).toEqual(wire.accelerators)
  expect(await client.probeFastFlowLm()).toEqual(recovered.plan)
})
it('carries consent, receipt and maintenance recovery through the SDK without changing legacy host actions', async () => {
  const op = awaiting
  expectTypeOf<Extract<FastFlowLmMaintenance, { state: 'held' }>['ready_to_mutate']>().toEqualTypeOf<true>()
  expectTypeOf<Exclude<FastFlowLmMaintenance, { state: 'held' }>['ready_to_mutate']>().toEqualTypeOf<false>()
  const samples = wire.maintenance
  const kind = example(samples.held.kind, 'replace')
  const m = {
    ...samples.held,
    kind,
    state: example(samples.held.state, 'held'),
    ready_to_mutate: example(samples.held.ready_to_mutate, true),
  } satisfies FastFlowLmMaintenance
  const stopping = {
    ...samples.stopping,
    kind: example(samples.stopping.kind, 'replace'),
    state: example(samples.stopping.state, 'stopping'),
    ready_to_mutate: example(samples.stopping.ready_to_mutate, false),
  } satisfies FastFlowLmMaintenance
  const completed = {
    ...samples.completed,
    kind: example(samples.completed.kind, 'replace'),
    state: example(samples.completed.state, 'completed'),
    ready_to_mutate: example(samples.completed.ready_to_mutate, false),
  } satisfies FastFlowLmMaintenance
  const { model_id, request_id } = m
  const maintenance = { model_id, request_id, kind: 'replace' } as const
  const operations = '/atomic/v1/runtimes/fastflowlm/operations'
  const guards = '/atomic/v1/models/fastflowlm/maintenance'
  const steps = [
    ['POST', operations, { request_id: op.request_id }, op],
    ['POST', operations + '/operation-1/consent', wire.consent, operation],
    [
      'POST',
      operations + '/operation-1/host-step-receipt',
      wire.receipt,
      { ...op, state: 'verifying', revision: 4 },
    ],
    ['POST', operations + '/operation-1/cancel', {}, { ...op, state: 'cancelled', revision: 5 }],
    [
      'POST',
      operations + '/operation-2/resume',
      { expected_revision: 7 },
      { ...op, operation_id: 'operation-2', state: 'verifying', revision: 8 },
    ],
    ['POST', guards, maintenance, { operation_id: stopping.operation_id, ready_to_mutate: false }],
    ['GET', guards + '/guard-1', null, stopping],
    ['GET', guards, null, [m]],
    ['GET', guards + '/guard-1', null, m],
    ['POST', guards + '/guard-1/complete', {}, completed],
  ] as const
  let index = 0
  const client = new CoreClient({
    baseUrl: 'http://fixture',
    token: 'token',
    fetch: async (url, init) => {
      const [method, path, body, result] = steps[index++]!
      expect([
        init?.method ?? 'GET',
        new URL(String(url)).pathname,
        init?.body ? JSON.parse(String(init.body)) : null,
      ]).toEqual([method, path, body])
      return Response.json(result)
    },
  })
  expect(await client.beginFastFlowLmOperation({ request_id: op.request_id })).toEqual(op)
  const consented = await client.consentFastFlowLmOperation(op.operation_id, {
    expected_revision: op.revision,
    approved_plan_digest: op.plan.plan_digest,
  })
  const step = consented.pending_host_step
  expect(consented.state).toBe('preparing-host')
  if (!step) throw Error('Missing host step after consent')
  expect(step.expected_operation_revision).toBe(consented.revision)
  expect(step.parameters_digest).toBe(canonicalDigest(step.parameters))
  expect(step.recipe_digest).toBe(consented.plan.recipe_digest)
  expect('manifest_digest' in step.parameters ? step.parameters.manifest_digest : null).toBe(
    consented.plan.manifest_digest
  )
  const receipt: ManagedHostReceipt = {
    step_id: step.step_id,
    nonce: step.nonce,
    expected_operation_revision: step.expected_operation_revision,
    recipe_digest: step.recipe_digest,
    parameters_digest: step.parameters_digest,
    receipt_id: 'receipt-1',
    outcome: 'completed',
  }
  expect(receipt).toEqual(relay.receipt)
  expect((await client.submitFastFlowLmHostReceipt(op.operation_id, receipt)).state).toBe('verifying')
  expect((await client.cancelFastFlowLmOperation(op.operation_id)).state).toBe('cancelled')
  expect((await client.resumeFastFlowLmOperation('operation-2', 7)).revision).toBe(8)
  expect(await client.beginFastFlowLmMaintenance(maintenance)).toEqual({
    operation_id: m.operation_id,
    ready_to_mutate: false,
  })
  expect(await client.fastFlowLmMaintenance(m.operation_id)).toEqual(stopping)
  expect(await client.listFastFlowLmMaintenance()).toEqual([m])
  expect(await client.fastFlowLmMaintenance(m.operation_id)).toEqual(m)
  expect(await client.completeFastFlowLmMaintenance(m.operation_id)).toEqual(completed)
  expect(MANAGED_HOST_ACTIONS).toEqual(
    expect.arrayContaining(['linux.install-container-runtime', 'windows.enable-wsl'])
  )
})
it('keeps defaults and independently overrides the three source documents', () => {
  expect(fastFlowLmSources('win32')).toEqual(wire.sources.defaults)
  expect(fastFlowLmSources('linux', wire.sources.overrides)).toEqual(wire.sources.resolved)
})
