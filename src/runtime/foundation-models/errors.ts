/**
 * How a Foundation Models server that did not start is explained.
 *
 * Ported from: tauri-plugin-foundation-models/src/error.rs (`FoundationModelsError::from_stderr`)
 * and the startup branches of commands.rs (`load_foundation_models_server`).
 * Contract: test/fixtures/app/foundation-models-errors.
 *
 * One deliberate difference. The Swift server says "Foundation model is downloading or not yet
 * ready" when the on-device model is still being fetched, and the Rust classifier only looked for
 * "model not ready" — so the one case with a clear remedy ("wait and try again") reached the user
 * as an unexpected error. "not yet ready" is recognised here as the same condition.
 */

import { AtomicCoreError } from '../../contracts/index.js'
import type { ExitInfo } from '../llamacpp/errors.js'

/** Written on stdout once the HTTP server is up (FoundationModelsServerCommand.swift). */
export const FOUNDATION_MODELS_READY_MARKERS = ['server is listening on', 'http server listening'] as const

/** The prefix of the line the server writes before exiting when the model is unavailable. */
export const FOUNDATION_MODELS_ERROR_PREFIX = '[foundation-models] ERROR:'

export function classifyFoundationModelsStderr(stderr: string): AtomicCoreError {
  const lower = stderr.toLowerCase()
  if (lower.includes('device is not eligible') || lower.includes('devicenoteligible'))
    return new AtomicCoreError(
      'FOUNDATION_MODELS_UNAVAILABLE',
      'This device is not eligible for Apple Intelligence.',
      stderr
    )
  if (lower.includes('apple intelligence is not enabled') || lower.includes('appleintelligencenotenabled'))
    return new AtomicCoreError(
      'FOUNDATION_MODELS_UNAVAILABLE',
      'Apple Intelligence is not enabled. Please enable it in System Settings → Apple Intelligence & Siri.',
      stderr
    )
  if (lower.includes('model not ready') || lower.includes('modelnotready') || lower.includes('not yet ready'))
    return new AtomicCoreError(
      'FOUNDATION_MODELS_UNAVAILABLE',
      'The Foundation Model is still downloading or not yet ready. Please wait and try again.',
      stderr
    )
  return new AtomicCoreError(
    'PROCESS_ERROR',
    'The Foundation Models server encountered an unexpected error.',
    stderr
  )
}

/** The reason line, when the server wrote one (the match is case-sensitive, as in the plugin). */
export function foundationModelsErrorLine(text: string): string | undefined {
  return text.split('\n').find((line) => line.includes(FOUNDATION_MODELS_ERROR_PREFIX))
}

/**
 * An exit before readiness. The server writes its reason and then exits 1; the plugin raced the two
 * and either error could win. Here the reason, when there is one, always wins.
 */
export function classifyFoundationModelsExit(exit: ExitInfo, stderr: string): AtomicCoreError {
  const reason = foundationModelsErrorLine(stderr)
  if (reason) return classifyFoundationModelsStderr(reason)
  return new AtomicCoreError(
    'SERVER_START_FAILED',
    `Foundation Models server exited with code ${exit.code ?? -1} before becoming ready. Ensure Apple Intelligence is enabled in System Settings.`
  )
}

export function foundationModelsTimeout(timeoutSecs: number): AtomicCoreError {
  return new AtomicCoreError(
    'SERVER_START_TIMED_OUT',
    `Foundation Models server did not become ready within ${timeoutSecs} seconds.`
  )
}

export function foundationModelsBinaryMissing(path: string): AtomicCoreError {
  return new AtomicCoreError('BINARY_NOT_FOUND', `foundation-models-server binary not found at: ${path}`)
}
