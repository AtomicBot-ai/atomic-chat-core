/** Internal diagnostic vocabulary. Never part of ErrorBody or persisted operation state. */
export const DIAGNOSTIC_VERSION = 'core-v1'
export const FAILURE_CATEGORIES = ['expected', 'operational', 'defect', 'unknown'] as const
export const FAILURE_COMPONENTS = [
  'core',
  'http',
  'runtime',
  'diffusion',
  'audio',
  'decision',
  'embedding',
  'downloads',
  'backend',
  'environment',
  'remote_access',
] as const
export const FAILURE_OPERATIONS = [
  'startup',
  'request',
  'event',
  'load',
  'inference',
  'exit',
  'restart',
  'job',
  'download',
  'install',
  'setup',
  'update',
  'remove',
  'tunnel',
] as const
export const FAILURE_STAGES = ['validate', 'prepare', 'spawn', 'ready', 'execute', 'stop', 'persist'] as const
export const FAILURE_REASONS = [
  'cancelled',
  'invalid_request',
  'not_configured',
  'not_found',
  'busy',
  'unsupported',
  'authentication',
  'out_of_memory',
  'disk_full',
  'disk_permission',
  'disk_file_locked',
  'disk_path_too_long',
  'disk_fs_limit',
  'disk_device_lost',
  'disk_io',
  'network',
  'timeout',
  'upstream',
  'integrity',
  'compute',
  'internal',
  'native_crash',
  'process_exit',
  'unknown',
] as const
export const NATIVE_FAILURES = [
  'native_crash',
  'sigsegv',
  'sigabrt',
  'sigkill',
  'access_violation',
  'stack_overflow',
  'assertion',
  'oom',
  'exit',
] as const

export interface FailureDiagnostic {
  category?: (typeof FAILURE_CATEGORIES)[number]
  component: (typeof FAILURE_COMPONENTS)[number]
  operation: (typeof FAILURE_OPERATIONS)[number]
  stage?: (typeof FAILURE_STAGES)[number]
  reason?: (typeof FAILURE_REASONS)[number]
  nativeFailure?: (typeof NATIVE_FAILURES)[number]
  engineVersion?: string
  exitCode?: number | null
  signal?: number | string | null
}

/** Observers must not throw or change the operation's result. The owner injects a safe observer. */
export type FailureObserver = (error: unknown, diagnostic: FailureDiagnostic) => void
