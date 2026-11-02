/**
 * What `audiocpp_server --log` prints, read: the model facts it traces while it loads, why it died,
 * and the engine's own error message in an HTTP answer. Pure.
 *
 * audio.cpp reports no progress while it generates (only family-specific `[TIMING …]` lines), so
 * nothing here tracks a job: a job moves through phases only.
 */

import type { AtomicCoreError } from '../contracts/index.js'
import { classifyExit, diagnosticTail } from '../diffusion/index.js'
import type { ExitInfo } from '../runtime/llamacpp/index.js'
import { audioError } from './errors.js'

/** `[TRACE ts=…] runtime.model.<key> <value>`: the facts the loader traces about the model. */
const MODEL_FACT = /\]\s+runtime\.model\.(variant|supports_speaker_reference)\s+(.*)$/
/** What `audiocpp_server` prints when its port was taken before it could bind it. */
const PORT_TAKEN = /could not bind|address already in use|EADDRINUSE/i

/** What the loader said about the model: `runtime.model.variant` and `supports_speaker_reference`. */
export interface AudioModelFacts {
  /** e.g. `0b6-base` (Qwen3-TTS Base), `Kokoro 82M`, `small` (Stable Audio). */
  variant?: string
  supportsSpeakerReference?: boolean
}

/** Fold one output line into `facts`; lines that say nothing about the model leave it as it is. */
export function readModelFact(facts: AudioModelFacts, line: string): void {
  const match = MODEL_FACT.exec(line)
  if (!match) return
  const value = (match[2] ?? '').trim()
  if (match[1] === 'variant') facts.variant = value
  else facts.supportsSpeakerReference = value === '1' || value.toLowerCase() === 'true'
}

/** Whether a server that exited while starting did so because its port was taken. */
export function exitedOnTakenAudioPort(details: string | undefined): boolean {
  return details !== undefined && PORT_TAKEN.test(details)
}

/** How an exit reads in a message: `code 1`, `signal SIGKILL`, or `unknown status`. */
export function describeAudioExit(exit: ExitInfo): string {
  if (exit.code !== null) return `code ${exit.code}`
  if (exit.signal !== null) return `signal ${String(exit.signal)}`
  return 'unknown status'
}

/** The exit code, or `128 + signal` for a signal the classifier knows by number (SIGKILL → 137). */
function exitCodeOf(exit: ExitInfo): number | undefined {
  if (exit.code !== null) return exit.code
  if (typeof exit.signal === 'number') return 128 + exit.signal
  if (exit.signal === 'SIGKILL') return 137
  return undefined
}

/** The error for a server that died before it listened: out of memory when ggml said so. */
export function audioEarlyExitError(exit: ExitInfo, tail: readonly string[]): AtomicCoreError {
  const text = diagnosticTail(tail)
  if (classifyExit(text, exitCodeOf(exit)) === 'OUT_OF_MEMORY')
    return audioError('OUT_OF_MEMORY', 'The audio model ran out of memory while loading.', text)
  return audioError(
    'MODEL_LOAD_FAILED',
    `audiocpp_server exited with ${describeAudioExit(exit)} while loading.`,
    text
  )
}

/** The error for a server that died while it generated. */
export function audioCrashError(exit: ExitInfo, tail: readonly string[]): AtomicCoreError {
  const text = diagnosticTail(tail)
  if (classifyExit(text, exitCodeOf(exit)) === 'OUT_OF_MEMORY')
    return audioError('OUT_OF_MEMORY', 'The audio engine ran out of memory while generating.', text)
  return audioError(
    'ENGINE_CRASHED',
    `The audio engine stopped while generating (${describeAudioExit(exit)}).`,
    text
  )
}

/**
 * The engine's words in an error answer: `{"error":{"message"}}` as audio.cpp writes it, a bare
 * `{"error":"…"}`, or the body itself when it is not JSON. At most 1000 characters.
 */
export function engineErrorMessage(body: string): string {
  let message: string | undefined
  try {
    const parsed = JSON.parse(body) as { error?: unknown; message?: unknown }
    const error = parsed?.error
    if (typeof error === 'string') message = error
    else if (error !== null && typeof error === 'object') {
      const inner = (error as { message?: unknown }).message
      if (typeof inner === 'string') message = inner
    } else if (typeof parsed?.message === 'string') message = parsed.message
  } catch {
    // Not JSON: the body is the message.
  }
  return [...(message ?? body).trim()].slice(0, 1000).join('')
}

/** A refusal the engine sent while it ran a job, on the closest code: out of memory, or rejected. */
export function engineRejection(status: number, body: string): AtomicCoreError {
  const message = engineErrorMessage(body)
  const details = message === '' ? `HTTP ${status}` : message
  if (classifyExit(message, undefined) === 'OUT_OF_MEMORY')
    return audioError('OUT_OF_MEMORY', 'The audio engine ran out of memory while generating.', details)
  return audioError('REQUEST_REJECTED', 'The audio engine refused the request.', details)
}
