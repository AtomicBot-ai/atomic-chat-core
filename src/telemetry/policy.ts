import { scrubText } from './scrub.js'
import type { ScrubContext } from './scrub.js'

/**
 * Tags the app may attach (`toSentryTags` + `SENTRY_TAG_KEYS` in the web app's
 * `AnalyticProvider.tsx`): the same zero-PII hardware and backend context its own projects carry.
 */
export const APP_TAG_KEYS: ReadonlySet<string> = new Set([
  'app_version',
  'platform',
  'os',
  'os_build',
  'arch',
  'cpu_avx',
  'gpu_vendor',
  'gpu_model',
  'vram_mb',
  'system_ram_mb',
  'nvidia_driver_version',
  'cuda_runtime_version',
  'vulkan_version',
  'active_backend',
  'device_backend_pref',
  'recommended_backend',
  'installer_type',
])

const TAG_KEY_RE = /^[a-z][a-z0-9_.]{0,31}$/
const MAX_TAG_VALUE = 100

/**
 * Tags as Sentry takes them: valid keys only (and only allowed ones, when a list is given), values
 * stringified, scrubbed, single-line and short. Empty values are dropped.
 */
export function sanitizeTags(
  tags: Record<string, unknown> | undefined,
  options: { allow?: ReadonlySet<string>; scrub?: ScrubContext } = {}
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, raw] of Object.entries(tags ?? {})) {
    if (!TAG_KEY_RE.test(key) || (options.allow && !options.allow.has(key))) continue
    if (raw === undefined || raw === null || typeof raw === 'object' || typeof raw === 'function') continue
    const value = scrubText(String(raw), options.scrub)
      .replace(/[\r\n\t]+/g, ' ')
      .trim()
      .slice(0, MAX_TAG_VALUE)
    if (value) out[key] = value
  }
  return out
}

/** Lines of engine output that say what went wrong, as opposed to what it was doing. */
const MARKER_RE =
  /GGML_ASSERT|\berror\b|\babort|\bassert|\bfailed\b|\bfailure\b|\bfatal\b|\bpanic|out of memory|\boom\b|cuda|metal|vulkan|segmentation|exception|\bcannot\b|\bunable\b/i
/** Lines that may carry what the user typed: prompts, chat messages, raw JSON bodies. */
const CONTENT_RE = /prompt|"content"|"messages"|\{"/i

/**
 * The few lines of engine output worth a report: marker lines only, never anything that may quote the
 * user's content (sd-server always runs with `-v`, and llama-server can be made verbose), capped in
 * count and size, newest kept, scrubbed.
 */
export function markerLines(
  text: string | undefined,
  options: { maxLines?: number; maxBytes?: number; scrub?: ScrubContext } = {}
): string | undefined {
  if (!text) return undefined
  const maxLines = options.maxLines ?? 20
  const maxBytes = options.maxBytes ?? 2048
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && MARKER_RE.test(line) && !CONTENT_RE.test(line))
    .map((line) => scrubText(line.length > 300 ? `${line.slice(0, 299)}…` : line, options.scrub))
  const kept: string[] = []
  let bytes = 0
  for (let i = lines.length - 1; i >= 0 && kept.length < maxLines; i--) {
    const line = lines[i] as string
    if (bytes + line.length + 1 > maxBytes) break
    kept.unshift(line)
    bytes += line.length + 1
  }
  return kept.length ? kept.join('\n') : undefined
}

/** A code worth a tag: the core's SCREAMING_SNAKE codes and Node's `E…` codes. */
export function errorCodeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null | undefined)?.code
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(code) ? code : undefined
}

const CANCELLATION_CODES = new Set(['MODEL_LOAD_CANCELLED', 'CANCELLED', 'AUTH_CANCELLED', 'ABORT_ERR'])

/** The user (or a caller) stopped the operation: the feature working, not a defect. */
export function isCancellation(error: unknown): boolean {
  const code = errorCodeOf(error)
  if (code && CANCELLATION_CODES.has(code)) return true
  return (error as { name?: unknown } | null | undefined)?.name === 'AbortError'
}

const CLIENT_ABORT_CODES = new Set([
  'ECONNRESET',
  'EPIPE',
  'ECONNABORTED',
  'ERR_STREAM_PREMATURE_CLOSE',
  'ERR_STREAM_DESTROYED',
  'ERR_STREAM_WRITE_AFTER_END',
])

/** A client that went away mid-request: its socket, not our code. */
export function isClientAbort(error: unknown): boolean {
  const code = errorCodeOf(error)
  return (code !== undefined && CLIENT_ABORT_CODES.has(code)) || isCancellation(error)
}

/**
 * Causes that live in the user's environment rather than in our code (the web app's
 * `ENVIRONMENT_FAILURE_CODES`): counted, but at `warning`, so they do not compete with crashes.
 */
export const ENVIRONMENT_FAILURE_CODES: ReadonlySet<string> = new Set([
  'OUT_OF_MEMORY',
  'MODEL_FILE_NOT_FOUND',
  'MODEL_FILE_CORRUPT',
  'MODEL_SHARDS_INCOMPLETE',
  'MODEL_ARCH_NOT_SUPPORTED',
  'MODEL_LOAD_TIMED_OUT',
  'MULTIMODAL_PROJECTOR_LOAD_FAILED',
  'BINARY_NOT_FOUND',
  'LIBRARY_PATH_INVALID',
  'OS_VERSION_UNSUPPORTED',
  'CPU_NO_AVX',
  'IO_ERROR',
  'INVALID_ARGUMENT',
])

/** Where an out-of-memory failure happened (the web app's `oomSubtype`). */
export function oomSubtype(text: string | undefined): string | undefined {
  if (!text) return undefined
  const t = text.toLowerCase()
  if (t.includes('cuda')) return 'cuda'
  if (t.includes('vulkan') || t.includes('vk_error')) return 'vulkan'
  if (t.includes('metal') || t.includes('iogpu') || t.includes('mtl')) return 'metal'
  if (t.includes('host') || t.includes('system memory') || t.includes('requires more ram')) return 'host_ram'
  return 'unknown'
}

/** The quantisation named in a model id (the web app's `quantFromModelId`). */
export function quantOf(modelId: string | undefined): string | undefined {
  const match = modelId?.match(
    /\b(IQ\d+_[A-Z0-9]+|Q\d+_[A-Z0-9_]+|Q\d+|MXFP\d+|\d+bit|bf16|fp16|fp8|f16|f32)\b/i
  )
  return match?.[1]
}
