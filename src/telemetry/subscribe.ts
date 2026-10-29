import { AtomicCoreError } from '../contracts/index.js'
import type { CoreEvents } from '../contracts/index.js'
import { audioFailureReport, captureReport, diffusionFailureReport, sessionDeathReport } from './reports.js'
import type { ErrorSink } from './types.js'

type ReportedEvent = 'session:died' | 'diffusion:error' | 'audio:error'

export interface ReportableEvents {
  on<K extends ReportedEvent>(name: K, listener: (payload: CoreEvents[K]) => void): () => void
}

/**
 * Report what the core already announces as events: an engine that died after it had loaded, and an
 * image or audio model, or one of their jobs, that failed. Subscribing keeps the runtimes and the
 * generation modules unaware of error reporting. Returns the unsubscribe.
 */
export function reportCoreEvents(
  events: ReportableEvents,
  sink: ErrorSink,
  platform: NodeJS.Platform
): () => void {
  const offDied = events.on('session:died', (died) => captureReport(sink, sessionDeathReport(died, platform)))
  const offDiffusion = events.on('diffusion:error', (failure) =>
    captureReport(
      sink,
      diffusionFailureReport({
        phase: failure.jobId === undefined ? 'load' : 'job',
        error: new AtomicCoreError(failure.code, failure.message, failure.details),
      })
    )
  )
  const offAudio = events.on('audio:error', (failure) =>
    captureReport(
      sink,
      audioFailureReport({
        phase: failure.jobId === undefined ? 'load' : 'job',
        error: new AtomicCoreError(failure.code, failure.message, failure.details),
      })
    )
  )
  return () => {
    offDied()
    offDiffusion()
    offAudio()
  }
}
