import type { LinuxMemlockStepParameters } from '../../contracts/index.js'
import { canonicalDigest } from '../../runtime/environment/index.js'
import { RUNTIME_MEMLOCK, RUNTIME_MEMLOCK_DIGEST } from '../../runtime/fastflowlm/environment/index.js'
import type { HostStepRequest } from './request-file.js'

export function linuxMemlockTarget(request: HostStepRequest): LinuxMemlockStepParameters | null {
  const p = request.parameters,
    process = p.runtime_process as Record<string, unknown> | undefined
  if (
    request.recipe_id !== RUNTIME_MEMLOCK.recipe_id ||
    request.recipe_digest !== RUNTIME_MEMLOCK_DIGEST ||
    canonicalDigest(p) !== request.parameters_digest ||
    Object.keys(p).sort().join(',') !== 'runtime_account,runtime_mode,runtime_process,runtime_service' ||
    typeof p.runtime_account !== 'string' ||
    !/^[a-z_][a-z0-9_-]{0,31}$/.test(p.runtime_account) ||
    p.runtime_account === 'root' ||
    !['desktop', 'interactive', 'system-service', 'user-service'].includes(String(p.runtime_mode)) ||
    (String(p.runtime_mode).endsWith('-service')
      ? typeof p.runtime_service !== 'string' ||
        !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}\.service$/.test(p.runtime_service)
      : p.runtime_service !== null) ||
    !process ||
    Object.keys(process).sort().join(',') !== 'boot_id,pid,start_ticks' ||
    typeof process.pid !== 'number' ||
    !Number.isSafeInteger(process.pid) ||
    process.pid <= 1 ||
    typeof process.start_ticks !== 'string' ||
    !/^\d+$/.test(process.start_ticks) ||
    typeof process.boot_id !== 'string' ||
    !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(process.boot_id)
  )
    return null
  return p as unknown as LinuxMemlockStepParameters
}
