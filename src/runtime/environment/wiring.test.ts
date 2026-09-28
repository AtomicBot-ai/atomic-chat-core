import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CoreEvents, ManagedHostStep, RequirementPlan, Sha256Digest } from '../../contracts/index.js'
import type { DataFolderEnv } from '../../config/index.js'
import type { EnvironmentProvisioner } from './service.js'
import { executorFor, provisionerFor, wireManagedRuntimes } from './wiring.js'
import type { ManagedRuntimes } from './wiring.js'

const DIGEST = `sha256:${'a'.repeat(64)}` as Sha256Digest

let root: string
/** Every service a test built, so none is still writing when the directory goes away. */
let wired: ManagedRuntimes[]

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'atomic-managed-'))
  wired = []
})
afterEach(async () => {
  for (const managed of wired) await managed.shutdown(AbortSignal.timeout(1_000)).catch(() => undefined)
  await rm(root, { recursive: true, force: true, maxRetries: 3 })
})

/** A machine environment pointed at a scratch directory, never at the real per-user one. */
const env = (platform: NodeJS.Platform): DataFolderEnv => ({
  platform,
  env: { ATOMIC_CORE_MANAGED_ROOT: root },
  homedir: '/home/u',
  exists: () => false,
  readFile: () => undefined,
})

const plan: RequirementPlan = {
  plan_digest: DIGEST,
  environment_id: 'default',
  target: { kind: 'environment' },
  availability: 'setup-required',
  recipe_id: 'ubuntu-24.04-docker-ce',
  recipe_digest: DIGEST,
  adopts_existing_engine: true,
  system_changes: [],
  download_bytes: null,
  required_disk_bytes: null,
  requires_elevation: false,
  may_require_relogin: false,
  may_require_reboot: false,
  blockers: [],
}

/** Enough of a recipe to let an operation run to the end, so the view can be watched changing. */
const fakeProvisioner = (hostStep: ManagedHostStep | null = null): EnvironmentProvisioner => ({
  probe: async () => ({ plan, host_step: hostStep }),
  prepare: async () => undefined,
  pull: async () => undefined,
  verify: async () => undefined,
  unloadResident: async () => undefined,
  activate: async () => undefined,
  remove: async () => undefined,
  cleanup: async () => undefined,
  inventory: {
    inspect: async () => ({ kind: 'absent' }) as const,
    needsRelogin: async () => false,
    needsReboot: async () => false,
    verifyCompletedSteps: async () => [],
    currentPlanDigest: async () => DIGEST,
  },
})

const wire = (platform: NodeJS.Platform, provisioner?: EnvironmentProvisioner | null) => {
  const events: { name: string; phase: string }[] = []
  let serial = 0
  const managed = wireManagedRuntimes({
    env: env(platform),
    instanceId: 'core-1',
    platform,
    emit: ((name: string, payload: CoreEvents['environment:operation']) => {
      events.push({ name, phase: payload.phase })
    }) as never,
    newId: () => `id-${(serial += 1)}`,
    ...(provisioner === undefined ? {} : { provisioner }),
  })
  wired.push(managed)
  return { managed, events }
}

describe('which machines can carry a managed runtime', () => {
  it('names the container engine each platform would drive, and none for the rest', () => {
    expect(executorFor('linux')).toBe('linux-docker')
    expect(executorFor('win32')).toBe('wsl-docker')
    expect(executorFor('darwin')).toBeNull()
    expect(executorFor('freebsd')).toBeNull()
  })

  it('offers no environment at all where no engine applies', () => {
    const { managed } = wire('darwin')
    // Not an environment that cannot be set up: there is nothing here to set up.
    expect(managed.environments()).toEqual([])
  })

  it('offers one environment per user on a platform that could carry it', () => {
    const { managed } = wire('linux')
    expect(managed.environments()).toHaveLength(1)
    expect(managed.environments()[0]?.executor).toBe('linux-docker')
    expect(managed.environments()[0]?.environment_id).toBe('default')
    expect(wire('win32').managed.environments()[0]?.executor).toBe('wsl-docker')
  })

  it('says unsupported while no host recipe exists, rather than inviting a setup that cannot run', () => {
    // `provisionerFor` returns null everywhere today, and this is how a caller finds that out.
    expect(provisionerFor('linux')).toBeNull()
    expect(provisionerFor('win32')).toBeNull()
    expect(wire('linux').managed.environments()[0]?.availability).toBe('unsupported')
    expect(wire('linux', fakeProvisioner()).managed.environments()[0]?.availability).toBe('setup-required')
  })
})

describe('what a snapshot shows', () => {
  it('starts with nothing in flight', () => {
    const { managed } = wire('linux', fakeProvisioner())
    expect(managed.operations()).toEqual([])
    expect(managed.environments()[0]?.active_operation_id).toBeNull()
  })

  it('carries the operation while it runs and lets go of it once it is over', async () => {
    const { managed, events } = wire('linux', fakeProvisioner())
    const started = await managed.service.begin('default', {
      request_id: 'req-1',
      target: { kind: 'environment' },
      kind: 'setup',
      descriptor_id: 'trtllm',
      approved_plan_digest: DIGEST,
    })
    await managed.service.idle()

    const operations = managed.operations()
    expect(operations).toHaveLength(1)
    expect(operations[0]?.operation_id).toBe(started.operation_id)
    expect(operations[0]?.phase).toBe('ready')
    // Finished: nothing is in flight on the environment any more.
    expect(managed.environments()[0]?.active_operation_id).toBeNull()
    // And every state it passed through was announced, so a client can follow from the snapshot.
    expect(events.map((event) => event.phase)).toEqual(['preparing-environment', 'verifying', 'ready'])
    expect(events.every((event) => event.name === 'environment:operation')).toBe(true)
  })

  it('points at the operation that is still waiting on the user', async () => {
    const step: ManagedHostStep = {
      step_id: 'step-1',
      action: 'linux.install-container-runtime',
      recipe_id: 'ubuntu-24.04-docker-ce',
      recipe_digest: DIGEST,
      parameters_digest: DIGEST,
      nonce: 'once-1',
      expected_operation_revision: 1,
    }
    const { managed } = wire('linux', fakeProvisioner(step))
    const started = await managed.service.begin('default', {
      request_id: 'req-1',
      target: { kind: 'environment' },
      kind: 'setup',
      descriptor_id: 'trtllm',
      approved_plan_digest: DIGEST,
    })
    await managed.service.idle()

    expect(managed.environments()[0]?.active_operation_id).toBe(started.operation_id)
    expect(managed.operations()[0]?.phase).toBe('preparing-host')
  })
})

describe('coming back to what a previous core left', () => {
  it('reads an unfinished operation back before anything is served', async () => {
    const first = wire('linux', fakeProvisioner())
    await first.managed.service.begin('default', {
      request_id: 'req-1',
      target: { kind: 'environment' },
      kind: 'setup',
      descriptor_id: 'trtllm',
      // No approval, so it stops at awaiting-consent and is still unfinished.
    })
    await first.managed.service.idle()
    expect(first.managed.operations()[0]?.phase).toBe('awaiting-consent')

    // A new core over the same shared root, as a restart really is.
    const second = wire('linux', fakeProvisioner())
    expect(second.managed.operations()).toEqual([])
    await second.managed.recover()

    const recovered = second.managed.operations()
    expect(recovered).toHaveLength(1)
    expect(recovered[0]?.request_id).toBe('req-1')
  })

  it('has nothing to recover on a machine that cannot carry one', async () => {
    const { managed } = wire('darwin')
    await managed.recover()
    expect(managed.operations()).toEqual([])
  })

  it('stops what is in flight on shutdown and leaves the record behind', async () => {
    const { managed } = wire('linux', fakeProvisioner())
    await managed.service.begin('default', {
      request_id: 'req-1',
      target: { kind: 'environment' },
      kind: 'setup',
      descriptor_id: 'trtllm',
    })
    await managed.shutdown(AbortSignal.timeout(1_000))

    const next = wire('linux', fakeProvisioner())
    await next.managed.recover()
    expect(next.managed.operations()).toHaveLength(1)
  })
})
