/**
 * The sink an owner can pass so every stdout/stderr line an engine prints reaches its own log, for
 * the whole life of a session, in addition to whatever `logPath`/`verbose` already route for one
 * load. Shared by llama.cpp (both providers), MLX, Foundation Models and the diffusion module's
 * `sd-server`, so the type lives here rather than under `core/`, which none of those may depend on
 * (`core/` depends on `runtime/`, never the reverse).
 */
export type BackendOutputSink = (line: {
  provider: string
  model: string
  stream: 'stdout' | 'stderr'
  line: string
}) => void

/**
 * Calls `sink` and swallows whatever it throws. The process that owns the child must keep running
 * even if a caller's sink misbehaves: the app's own sink (the log-file writer) never throws, but a
 * library consumer's might.
 */
export function reportBackendOutput(
  sink: BackendOutputSink | undefined,
  line: Parameters<BackendOutputSink>[0]
): void {
  if (!sink) return
  try {
    sink(line)
  } catch {
    // Deliberately ignored: a misbehaving sink must not take the backend process down with it.
  }
}
