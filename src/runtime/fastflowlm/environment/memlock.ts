import type {
  FastFlowLmAccelerators,
  FastFlowLmProbePlan,
  LinuxRuntimeProcess,
} from '../../../contracts/index.js'
import { canonicalDigest } from '../../environment/index.js'
import type { PreparationHost } from './plan.js'

/** Built-in OS resource policy, independent of driver/package qualification. */
export const RUNTIME_MEMLOCK = {
  recipe_id: 'linux.runtime-memlock',
  revision: 1,
  bytes: '2147483648',
} as const
export const RUNTIME_MEMLOCK_DIGEST = canonicalDigest(RUNTIME_MEMLOCK)
export function runtimeProcess(stat: string, boot: string): LinuxRuntimeProcess | undefined {
  const pid = Number(stat.split(' ')[0]),
    tail = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
  const start = tail[19],
    boot_id = boot.trim()
  if (
    !Number.isSafeInteger(pid) ||
    pid <= 1 ||
    !start ||
    !/^\d+$/.test(start) ||
    !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(boot_id)
  )
    return undefined
  return { pid, start_ticks: start, boot_id }
}
export function memoryPlan(
  facts: FastFlowLmAccelerators,
  host: PreparationHost,
  build: string | null
): FastFlowLmProbePlan | null {
  const target = facts.devices.filter((d) => d.generation === 'xdna2')
  if (
    host.os !== 'linux' ||
    host.arch !== 'x64' ||
    !host.process ||
    host.mutable !== true ||
    !facts.runtime_account ||
    !facts.runtime_mode ||
    facts.runtime_mode.endsWith('-service') !== Boolean(facts.runtime_service) ||
    target.length !== 1 ||
    target[0]!.driver !== 'bound' ||
    target[0]!.accessible !== true ||
    facts.required.memlock_bytes !== RUNTIME_MEMLOCK.bytes ||
    !facts.memlock_bytes ||
    !/^\d+$/.test(facts.memlock_bytes) ||
    BigInt(facts.memlock_bytes) >= BigInt(RUNTIME_MEMLOCK.bytes) ||
    !facts.blockers.includes('memlock-too-low') ||
    facts.blockers.some(
      (b) =>
        ![
          'memlock-too-low',
          'native-memlock-unconfirmed',
          'native-validation-failed',
          'xrt-device-unavailable',
          'engine-not-installed',
        ].includes(b)
    )
  )
    return null
  const code =
    facts.runtime_mode === 'system-service'
      ? 'service-memlock'
      : facts.runtime_mode === 'user-service'
        ? 'user-service-memlock'
        : 'account-memlock'
  const result = {
    status: 'action-required' as const,
    runtime_account: facts.runtime_account,
    runtime_mode: facts.runtime_mode,
    runtime_service: facts.runtime_service,
    runtime_process: host.process,
    engine_version: build,
    manifest_id: null,
    manifest_digest: null,
    recipe_id: RUNTIME_MEMLOCK.recipe_id,
    recipe_revision: RUNTIME_MEMLOCK.revision,
    recipe_digest: RUNTIME_MEMLOCK_DIGEST,
    packages: [],
    changes: [
      {
        code,
        text: 'Raise the running server locked-memory limit to 2 GiB and save it for future sessions and service starts.',
        params: {
          account: facts.runtime_account,
          bytes: RUNTIME_MEMLOCK.bytes,
          ...(facts.runtime_service ? { unit: facts.runtime_service } : {}),
        },
      },
    ],
    blockers: [...facts.blockers],
  }
  return {
    ...result,
    plan_digest: canonicalDigest({ result, devices: facts.devices, limits: facts.memlock_bytes }),
  }
}
