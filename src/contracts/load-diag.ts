/**
 * A machine-readable line core appends as the LAST line of a model-load failure's `details`:
 *
 *   atomic-core-diag {"exit_code":"0xC0000135","stage":"spawn","backend":"win-cuda-13.3-x64",...}
 *
 * The app keeps only the last ~2 KB of `details` as `model_load.stderr_tail`, so the line must stay
 * at the end and short. The app parses it with the same prefix (web-app `parseLoadDiag`); this is a
 * wire contract, so keys are only ever added.
 */
export const LOAD_DIAG_PREFIX = 'atomic-core-diag '

export interface LoadDiag {
  /** Process exit code as `0x`-prefixed upper-case hex on Windows, decimal elsewhere. */
  exit_code?: string
  /** Signal name on Unix (`SIGSEGV`). */
  signal?: string
  /** Where the load stopped: before the process ran, while loading weights, waiting for ready, or after ready. */
  stage?: 'spawn' | 'load' | 'ready' | 'runtime'
  /** The backend directory name that actually ran, e.g. `win-cuda-13.3-x64`. */
  backend?: string
  /** The llama.cpp build tag that actually ran, e.g. `b12019`. */
  build?: string
  /** Set when core retried on another build after this failure. */
  fallback_from?: string
  fallback_to?: string
  /** Whether the retry on `fallback_to` loaded. */
  fallback_ok?: boolean
  /** True when stderr was empty: the process died before printing anything. */
  empty_stderr?: boolean
}

export function formatLoadDiag(diag: LoadDiag): string {
  const clean: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(diag)) if (v !== undefined && v !== null && v !== '') clean[k] = v
  return `${LOAD_DIAG_PREFIX}${JSON.stringify(clean)}`
}

/** Append the diag line to existing details, replacing an earlier diag line if there is one. */
export function withLoadDiag(details: string | undefined, diag: LoadDiag): string {
  const base = stripLoadDiag(details ?? '').replace(/\s+$/, '')
  const line = formatLoadDiag(diag)
  return base ? `${base}\n${line}` : line
}

export function stripLoadDiag(details: string): string {
  return details
    .split('\n')
    .filter((l) => !l.startsWith(LOAD_DIAG_PREFIX))
    .join('\n')
}

export function parseLoadDiag(text: string | undefined | null): LoadDiag | undefined {
  if (!text) return undefined
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim()
    if (!line.startsWith(LOAD_DIAG_PREFIX)) continue
    try {
      const parsed = JSON.parse(line.slice(LOAD_DIAG_PREFIX.length)) as unknown
      return parsed && typeof parsed === 'object' ? (parsed as LoadDiag) : undefined
    } catch {
      return undefined
    }
  }
  return undefined
}
