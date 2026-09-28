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
 * What one engine session hands its lines to: forwards each to `sink` and swallows whatever the sink
 * throws, because the process that owns the child must keep running even if a caller's sink
 * misbehaves (the app's own sink, the log-file writer, never throws; a library consumer's might).
 * The first throw is surfaced once through `log`, so a broken sink does not lose all engine output
 * silently; later throws in the same session stay quiet, and the engine line itself is never logged.
 * Build one per spawned process.
 */
export function backendOutputReporter(
  sink: BackendOutputSink | undefined,
  log?: (level: 'warn', message: string) => void
): (line: Parameters<BackendOutputSink>[0]) => void {
  if (!sink) return () => {}
  let warned = false
  return (line) => {
    try {
      sink(line)
    } catch (error) {
      if (warned) return
      warned = true
      const reason = error instanceof Error ? error.message : String(error)
      log?.('warn', `backendOutput sink threw: ${reason}; further sink errors for this session are ignored`)
    }
  }
}
