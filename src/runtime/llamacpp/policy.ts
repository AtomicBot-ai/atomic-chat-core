/**
 * Small policy helpers of the llama.cpp extension, ported verbatim from
 * `extensions/llamacpp-upstream-extension/src/{util,index}.ts`: backend-id predicates, the AVX
 * preflight, backend-mismatch classification, env parsing, readiness timeout, load-error shaping.
 */

import { AtomicCoreError } from '../../contracts/index.js'
import type { ErrorCode, RuntimeDeviceInfo } from '../../contracts/index.js'

export const CPU_NO_AVX_ERROR_CODE = 'CPU_NO_AVX' as const
export const CPU_NO_AVX_MESSAGE =
  "Your CPU is too old to run this model: it doesn't support the AVX instruction set that the bundled engine requires. The app cannot run local models on this processor."
export const BACKEND_NOT_CONFIGURED_MESSAGE =
  'Llama.cpp backend is not configured (version_backend is missing or invalid). Check Settings → Llama.cpp — Version & Backend, or reinstall the application.'

/** Readiness wait floor (30 min): large models on cold storage outran the 600 s default. */
export const MODEL_LOAD_READY_TIMEOUT_FLOOR_SECS = 1800

export function stripBom(s: string): string {
  return s.replace(/\uFEFF/g, '').trim()
}

/** The extension's strict build-number parser (`b6325` only; the unified fork tag yields null). */
export function parseBuildNumberStrict(version: string): number | null {
  const m = /^b(\d+)$/.exec(version)
  return m ? parseInt(m[1] as string, 10) : null
}

/** A concrete `<version>/<backend>`: not empty, not `none`, has a `/`, not the `latest/` sentinel. */
export function isConcreteVersionBackend(vb: string | undefined | null): boolean {
  const v = stripBom(vb ?? '')
  if (!v || v === 'none') return false
  if (!v.includes('/')) return false
  if (v.startsWith('latest/')) return false
  return true
}

/** `win-cpu-x64`, `linux-cpu-arm64`, … — never the macOS ids. */
export function isCpuBackend(backend: string | undefined | null): boolean {
  return stripBom(backend ?? '')
    .toLowerCase()
    .includes('-cpu-')
}

export function cpuHasAvx(extensions: string[] | undefined | null): boolean {
  if (!extensions || extensions.length === 0) return false
  return extensions.some((e) => {
    const x = e.toLowerCase()
    return x === 'avx' || x === 'avx2' || x.startsWith('avx512')
  })
}

/** Block only on a positive no-AVX signal: x86, a CPU backend, a non-empty list lacking AVX. */
export function isUnsupportedNoAvxCpu(
  arch: string | undefined | null,
  backend: string | undefined | null,
  extensions: string[] | undefined | null
): boolean {
  const a = (arch ?? '').trim().toLowerCase()
  const isX86 = a === 'x86_64' || a === 'x86' || a === 'amd64'
  if (!isX86) return false
  if (!isCpuBackend(backend)) return false
  if (!extensions || extensions.length === 0) return false
  return !cpuHasAvx(extensions)
}

const GPU_BACKEND_CATEGORIES = new Set([
  'cuda-cu13',
  'cuda-cu13.0',
  'cuda-cu12.4',
  'cuda-cu12.0',
  'cuda-cu11.7',
  'vulkan',
])

export function isGpuBackendCategory(category: string): boolean {
  return GPU_BACKEND_CATEGORIES.has(category)
}

export type GpuKind = 'cuda' | 'vulkan' | 'other'

export function gpuKindOf(category: string): GpuKind {
  if (category.startsWith('cuda-')) return 'cuda'
  if (category === 'vulkan') return 'vulkan'
  return 'other'
}

/** Zero offloaded layers is conclusive; an absent device is not treated as CPU. */
export function runtimeRanOnCpu(runtimeDevice: Partial<RuntimeDeviceInfo> | undefined | null): boolean {
  if (!runtimeDevice) return false
  if (runtimeDevice.gpu_layers_offloaded === 0) return true
  const primary = (runtimeDevice.primary_device ?? '').trim()
  if (!primary) return false
  return primary === 'CPU' || primary.startsWith('CPU_')
}

export type BackendMismatch =
  | { kind: 'ok' }
  | { kind: 'silent-fallback'; configured: string; effective: string }
  | {
      kind: 'runtime-cpu'
      configured: string
      primaryDevice: string
      offloaded: number | null
      total: number | null
      gpuKind: GpuKind
      cudaRuntimeMissing: boolean
      deviceInitError: string | null
    }
  | { kind: 'suboptimal-config'; configured: string; ideal: string }

/**
 * Compare what the UI shows, what was launched and what the process reports. Precedence: silent
 * swap, then a GPU build that ran on the CPU (unless `-ngl 0` was requested), then a better tier.
 */
export function classifyBackendMismatch(input: {
  configuredBackend: string | undefined | null
  effectiveBackend: string | undefined | null
  runtimeDevice?: Partial<RuntimeDeviceInfo> | null
  idealBackend?: string | null
  requestedGpuLayers?: number | null
  categoryOf: (backend: string) => string
}): BackendMismatch {
  const configured = stripBom(input.configuredBackend ?? '')
  const effective = stripBom(input.effectiveBackend ?? '') || configured
  if (!configured) return { kind: 'ok' }
  if (effective && effective !== configured) return { kind: 'silent-fallback', configured, effective }
  const effectiveCategory = input.categoryOf(effective)
  const cpuOnlyByRequest = input.requestedGpuLayers === 0
  if (isGpuBackendCategory(effectiveCategory) && !cpuOnlyByRequest && runtimeRanOnCpu(input.runtimeDevice)) {
    return {
      kind: 'runtime-cpu',
      configured: effective,
      primaryDevice: (input.runtimeDevice?.primary_device ?? '').trim() || 'CPU',
      offloaded: input.runtimeDevice?.gpu_layers_offloaded ?? null,
      total: input.runtimeDevice?.total_layers ?? null,
      gpuKind: gpuKindOf(effectiveCategory),
      cudaRuntimeMissing: input.runtimeDevice?.cuda_runtime_missing === true,
      deviceInitError: input.runtimeDevice?.device_init_error ?? null,
    }
  }
  const ideal = stripBom(input.idealBackend ?? '')
  if (ideal) {
    const idealCategory = input.categoryOf(ideal)
    if (isGpuBackendCategory(idealCategory) && idealCategory !== effectiveCategory) {
      return { kind: 'suboptimal-config', configured: effective, ideal }
    }
  }
  return { kind: 'ok' }
}

/** `KEY=VALUE;KEY2=VALUE2` — keys starting with `LLAMA` are reserved and dropped. */
export function parseEnvString(
  envString: string,
  target: Record<string, string> = {}
): Record<string, string> {
  envString
    .split(';')
    .filter((pair) => pair.trim())
    .forEach((pair) => {
      const [key, ...valueParts] = pair.split('=')
      const cleanKey = key?.trim()
      if (cleanKey && valueParts.length > 0 && !cleanKey.startsWith('LLAMA')) {
        target[cleanKey] = valueParts.join('=').trim()
      }
    })
  return target
}

/** Never below the floor; honours a larger configured value; non-numbers read as 600. */
export function modelLoadReadyTimeoutSecs(configuredTimeoutSecs: number | string): number {
  const configured = Number(configuredTimeoutSecs)
  const base = Number.isFinite(configured) && configured > 0 ? configured : 600
  return Math.max(base, MODEL_LOAD_READY_TIMEOUT_FLOOR_SECS)
}

/** Readable text of any load error: message + details + `[code]`; never `[object Object]`. */
export function formatLoadError(err: unknown): string {
  if (err instanceof Error) {
    const e = err as Error & { details?: unknown; code?: unknown }
    const parts = [err.message]
    if (typeof e.details === 'string' && e.details.trim()) parts.push(e.details.trim())
    const code = typeof e.code === 'string' && e.code ? ` [${e.code}]` : ''
    return err.message ? `${parts.join('\n')}${code}` : String(err)
  }
  if (err && typeof err === 'object') {
    const e = err as { code?: unknown; message?: unknown; details?: unknown }
    const parts: string[] = []
    if (typeof e.message === 'string' && e.message.trim()) parts.push(e.message.trim())
    if (typeof e.details === 'string' && e.details.trim()) parts.push(e.details.trim())
    if (parts.length > 0) {
      const code = typeof e.code === 'string' && e.code ? ` [${e.code}]` : ''
      return `${parts.join('\n')}${code}`
    }
    try {
      const json = JSON.stringify(err)
      if (json && json !== '{}' && json !== 'null') return json
    } catch {
      /* fall through */
    }
  }
  return String(err)
}

/** Codes that describe a recoverable user/environment condition, not a crash (kept out of Sentry). */
export const RECOVERABLE_LOAD_ERROR_CODES: ReadonlySet<string> = new Set([
  'MODEL_FILE_NOT_FOUND',
  'MODEL_FILE_CORRUPT',
  'MODEL_SHARDS_INCOMPLETE',
  'MULTIMODAL_PROJECTOR_LOAD_FAILED',
  'BINARY_NOT_FOUND',
  'MODEL_ARCH_NOT_SUPPORTED',
  'OS_VERSION_UNSUPPORTED',
  'CPU_NO_AVX',
])

export function isRecoverableLoadError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code
  return typeof code === 'string' && RECOVERABLE_LOAD_ERROR_CODES.has(code)
}

/** The extension's `codedLoadError`, as an `AtomicCoreError`. */
export function codedLoadError(code: ErrorCode, message: string, details?: string): AtomicCoreError {
  return new AtomicCoreError(code, message, details)
}
