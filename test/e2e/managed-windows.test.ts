/**
 * The managed container runtime on Windows through the compiled binary (change
 * `add-tensorrt-llm-windows`, task 2.10): Atomic Chat's own WSL distribution, set up from a machine
 * without WSL — the elevated `windows.enable-wsl` step through the app's UAC, the restart, the import of
 * the verified rootfs, the guest prepared, the engine pulled inside it, localhost forwarding checked —
 * then a broken forwarding, and the removal of the engine and of the environment.
 *
 * The Windows machine is a folder (`ATOMIC_MANAGED_TEST_WINDOWS`, `test/helpers/fake-windows-machine.ts`):
 * `wsl.exe` is `fake-wsl.mjs` run by this Node, which runs the same on a Windows runner as anywhere else
 * — no `.cmd`, no shell — so this suite is the Windows path's e2e on `windows-2022` and runs on every
 * other runner too. Nothing here runs a real WSL, Docker or GPU.
 *
 * No imports from `src/`: a packaging change that breaks a route cannot pass by type-checking.
 */
import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as core from '../helpers/compiled-core.js'
import type { ReadyLine } from '../helpers/compiled-core.js'
import {
  DESCRIPTOR_ID,
  ENGINE_IMAGE,
  fakeWindowsMachine,
  type FakeWindowsMachine,
} from '../helpers/fake-windows-machine.js'

let dataFolder: string
let managedRoot: string
let machine: FakeWindowsMachine | undefined
const daemons: ChildProcess[] = []

beforeEach(async () => {
  dataFolder = await mkdtemp(join(tmpdir(), 'atomic-core-e2e-windows-'))
  managedRoot = await mkdtemp(join(tmpdir(), 'atomic-managed-e2e-windows-'))
  machine = undefined
})
afterEach(async () => {
  for (const daemon of daemons.splice(0)) daemon.kill('SIGKILL')
  if (machine !== undefined) await machine.close()
  await rm(dataFolder, { recursive: true, force: true, maxRetries: 3 })
  await rm(managedRoot, { recursive: true, force: true, maxRetries: 3 })
})

const start = () =>
  core.startDaemon(dataFolder, daemons, [], {
    ATOMIC_CORE_MANAGED_ROOT: managedRoot,
    ...(machine?.env ?? {}),
  })

/** SIGKILL, the way a crash (or a Windows restart) ends a core. */
const stop = async (): Promise<void> => {
  for (const daemon of daemons.splice(0)) {
    const exited = new Promise((resolve) => daemon.once('exit', resolve))
    daemon.kill('SIGKILL')
    await exited
  }
}

const control = (ready: ReadyLine, path: string, init: RequestInit = {}) =>
  core.control(dataFolder, ready, path, init)
const post = (ready: ReadyLine, path: string, body?: unknown) =>
  control(ready, path, { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) })

interface Operation {
  operation_id: string
  revision: number
  phase: string
  plan_digest: string | null
  pending_host_step: {
    step_id: string
    action: string
    nonce: string
    expected_operation_revision: number
    recipe_digest: string
    parameters_digest: string
    parameters: Record<string, unknown>
  } | null
  error: { code: string; message: string; details?: string } | null
}

interface Plan {
  availability: string
  requires_elevation: boolean
  may_require_reboot: boolean
  system_changes: { code: string; params?: Record<string, string> }[]
  blockers: { reason?: string }[]
}

interface Snapshot {
  environments: {
    executor: string
    availability: string
    distribution: { name: string; path: string; size_bytes: number | null } | null
    installations: { installation_id: string; status: string }[]
  }[]
}

const TARGET = { kind: 'runtime' as const, installation_id: 'tensorrt-llm', engine_id: 'tensorrt-llm' }

const getOperation = async (ready: ReadyLine, id: string): Promise<Operation> =>
  (await (await control(ready, `/environments/operations/${id}`)).json()) as Operation

async function poll(
  ready: ReadyLine,
  id: string,
  done: (o: Operation) => boolean,
  ms = 30_000
): Promise<Operation> {
  const deadline = Date.now() + ms
  let current = await getOperation(ready, id)
  while (!done(current) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50))
    current = await getOperation(ready, id)
  }
  expect(done(current), `stuck at ${current.phase}: ${JSON.stringify(current.error)}`).toBe(true)
  return current
}

const snapshot = async (ready: ReadyLine): Promise<Snapshot> =>
  (await (await control(ready, '/snapshot')).json()) as Snapshot

/** Begin, wait for the plan, approve it: the consent a user gives in the setup dialog. */
async function begin(
  ready: ReadyLine,
  body: Record<string, unknown>
): Promise<{ id: string; plan: Operation }> {
  const started = (await (await post(ready, '/environments/default/operations', body)).json()) as Operation
  const asking = await poll(
    ready,
    started.operation_id,
    (o) => o.phase === 'awaiting-consent' || o.phase === 'failed'
  )
  return { id: started.operation_id, plan: asking }
}

async function approve(ready: ReadyLine, id: string, asking: Operation): Promise<void> {
  const res = await post(ready, `/environments/operations/${id}/resume`, {
    expected_revision: asking.revision,
    approved_plan_digest: asking.plan_digest,
  })
  expect(res.status).toBe(200)
}

const setup = (requestId: string) => ({
  request_id: requestId,
  target: TARGET,
  kind: 'setup',
  descriptor_id: DESCRIPTOR_ID,
})

/** On a machine whose WSL already starts VMs, the whole setup up to `ready`. */
async function installEngine(ready: ReadyLine): Promise<void> {
  const { id, plan } = await begin(ready, setup('req-install'))
  await approve(ready, id, plan)
  await poll(ready, id, (o) => o.phase === 'ready', 60_000)
}

describe.skipIf(!existsSync(core.BIN))('the managed environment on Windows through the compiled core', () => {
  it('no WSL → UAC → restart → import → ready, with no second consent', async () => {
    machine = await fakeWindowsMachine({ installed: false, distributions: [], guests: {} })
    let { ready } = await start()

    const probe = (await (
      await post(ready, '/environments/probe', { descriptor_id: DESCRIPTOR_ID, target: TARGET })
    ).json()) as Plan
    expect(probe).toMatchObject({
      availability: 'setup-required',
      requires_elevation: true,
      may_require_reboot: true,
    })
    expect(probe.system_changes.map((change) => change.code)).toEqual([
      'enable-wsl',
      'import-distribution',
      'provision-distribution',
    ])

    const { id, plan } = await begin(ready, setup('req-1'))
    await approve(ready, id, plan)
    const waiting = await poll(ready, id, (o) => o.phase === 'preparing-host' && o.pending_host_step !== null)
    const step = waiting.pending_host_step!
    expect(step.action).toBe('windows.enable-wsl')
    expect(step.parameters).toEqual({})

    // The app ran `atomic-chat-core.exe host-step exec` through UAC: WSL is in, Windows must restart.
    machine.enableWsl()
    const receipt = await post(ready, `/environments/operations/${id}/host-step-result`, {
      step_id: step.step_id,
      nonce: step.nonce,
      expected_operation_revision: step.expected_operation_revision,
      recipe_digest: step.recipe_digest,
      parameters_digest: step.parameters_digest,
      outcome: 'reboot-required',
      receipt_id: 'receipt-1',
    })
    expect(receipt.status).toBe(200)
    expect(((await receipt.json()) as Operation).phase).toBe('reboot-required')

    // The app opens again before the restart: still waiting.
    await stop()
    ;({ ready } = await start())
    expect((await poll(ready, id, (o) => o.phase === 'reboot-required')).phase).toBe('reboot-required')

    // Restarted: the operation goes on by itself, under the consent it already has.
    await stop()
    machine.reboot()
    ;({ ready } = await start())
    await poll(ready, id, (o) => o.phase === 'ready', 60_000)

    const calls = machine.wslCalls()
    expect(calls.some((argv) => argv[0] === '--import' && argv[1] === 'AtomicChat')).toBe(true)
    // Docker ran in the guest, as root; the engine image came in through the guest's Engine API.
    expect(
      calls.some((argv) => argv.slice(0, 4).join(' ') === '-d AtomicChat -u root' && argv.includes('curl'))
    ).toBe(true)
    expect(machine.wsl().guests?.['AtomicChat']?.host?.images).toContain(ENGINE_IMAGE)
    const environment = (await snapshot(ready)).environments[0]
    expect(environment?.executor).toBe('wsl-docker')
    expect(environment?.installations).toEqual([
      expect.objectContaining({ installation_id: 'tensorrt-llm', status: 'ready' }),
    ])
  })

  it('forwarding turned off in .wslconfig: the setup fails at verifying with wsl-localhost-forwarding, the file untouched', async () => {
    machine = await fakeWindowsMachine({
      installed: true,
      wsl_version: '2.4.4.0',
      ready: true,
      distributions: [],
      guests: {},
    })
    machine.setWsl((state) => ({ ...state, forwarding: false }))
    machine.setWindows((state) => ({ ...state, wslconfig: '[wsl2]\nlocalhostForwarding=false\n' }))
    const { ready } = await start()
    const { id, plan } = await begin(ready, setup('req-1'))
    await approve(ready, id, plan)
    const failed = await poll(ready, id, (o) => o.phase === 'failed', 60_000)
    expect(failed.error).toMatchObject({
      code: 'MANAGED_PREREQUISITE_BLOCKED',
      details: 'wsl-localhost-forwarding',
    })
    expect(failed.error?.message).toMatch(/localhostForwarding=true/)
    expect(machine.windows().wslconfig).toBe('[wsl2]\nlocalhostForwarding=false\n')
  })

  it('removing the engine, then the environment: refused while the engine is installed, then wsl --unregister of ours', async () => {
    machine = await fakeWindowsMachine({
      installed: true,
      wsl_version: '2.4.4.0',
      ready: true,
      distributions: [{ name: 'Ubuntu', state: 'Stopped', version: 2, is_default: true }],
      guests: {},
    })
    const { ready } = await start()
    await installEngine(ready)

    const early = await begin(ready, {
      request_id: 'rm-env-1',
      target: { kind: 'environment' },
      kind: 'remove',
    })
    expect(early.plan.phase).toBe('failed')
    expect(early.plan.error?.details).toBe('engines-installed')

    const engine = await begin(ready, {
      request_id: 'rm-engine',
      target: TARGET,
      kind: 'remove',
      retain_models: false,
    })
    await approve(ready, engine.id, engine.plan)
    await poll(ready, engine.id, (o) => o.phase === 'removed', 60_000)

    const env = await begin(ready, {
      request_id: 'rm-env-2',
      target: { kind: 'environment' },
      kind: 'remove',
    })
    expect(env.plan.phase).toBe('awaiting-consent')
    await approve(ready, env.id, env.plan)
    await poll(ready, env.id, (o) => o.phase === 'removed', 60_000)

    expect(machine.wslCalls()).toContainEqual(['--unregister', 'AtomicChat'])
    expect((machine.wsl().distributions ?? []).map((d) => d.name)).toEqual(['Ubuntu'])
    const probe = (await (
      await post(ready, '/environments/probe', { descriptor_id: DESCRIPTOR_ID, target: TARGET })
    ).json()) as Plan
    expect(probe.system_changes.map((change) => change.code)).toContain('import-distribution')
  })

  it('wsl --shutdown under a loaded model: the session ends with wsl-stopped, and a new load brings the distribution back', async () => {
    machine = await fakeWindowsMachine({
      installed: true,
      wsl_version: '2.4.4.0',
      ready: true,
      distributions: [],
      guests: {},
    })
    const { ready } = await start()
    await installEngine(ready)

    // The app downloads into the root core names: a folder in the guest (here, the folder standing in for it).
    const location = (await (await control(ready, '/managed-models/location')).json()) as {
      root: string
    }
    const dir = join(location.root, 'acme', 'llama')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({ architectures: ['LlamaForCausalLM'], dtype: 'bfloat16' })
    )
    await writeFile(join(dir, 'model.safetensors'), Buffer.alloc(20, 1))
    await writeFile(
      join(dir, 'model.yml'),
      'name: acme/llama\nrepository: acme/llama\nrevision: deadbeef\narchitectures:\n  - LlamaForCausalLM\nquantization: bf16\nfiles:\n  - path: model.safetensors\n    size: 20\n    sha256: null\n'
    )

    const loaded = await post(ready, '/models/tensorrt-llm/acme/llama/load')
    expect(loaded.status, await loaded.clone().text()).toBe(200)
    const sessions = async () =>
      ((await (await control(ready, '/sessions')).json()) as { sessions: { model_id: string }[] }).sessions
    expect((await sessions()).map((session) => session.model_id)).toEqual(['acme/llama'])

    machine.shutdown()
    const deadline = Date.now() + 15_000
    while ((await sessions()).length > 0 && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 100))
    expect(await sessions()).toEqual([])

    machine.bootable()
    const again = await post(ready, '/models/tensorrt-llm/acme/llama/load')
    expect(again.status, await again.clone().text()).toBe(200)
    expect((await sessions()).map((session) => session.model_id)).toEqual(['acme/llama'])
  })
})
