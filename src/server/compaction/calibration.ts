/**
 * How far off the text estimate is for one session, learned from the prompt sizes its engine
 * reports: the `usage.prompt_tokens` of a request, against the estimate of that same request. Only
 * engines that cannot count a prompt beforehand need it (MLX, Strata, FastFlowLM, Foundry Local,
 * TensorRT-LLM); the last observation wins, so a session that changed its template is followed at
 * once.
 */

import type { CompactionTarget } from './engine.js'

export const CALIBRATION_MIN_RATIO = 0.5
export const CALIBRATION_MAX_RATIO = 2
/** The margin an estimate carries until its session has answered with a prompt size. */
export const UNCALIBRATED_MARGIN = 1.1
/**
 * Below this estimate a request teaches nothing: a "hi" is mostly the template's own tokens, and the
 * ratio it gives would inflate every later estimate.
 */
export const MIN_CALIBRATION_ESTIMATE = 256
/** Sessions remembered at most; the oldest is forgotten first. */
export const MAX_CALIBRATED_SESSIONS = 64

/** `observed / estimate`, clamped; `undefined` when the pair teaches nothing. */
export function calibrationRatio(estimate: number, observed: number): number | undefined {
  if (!(estimate >= MIN_CALIBRATION_ESTIMATE) || !Number.isFinite(observed) || !(observed > 0))
    return undefined
  return Math.min(CALIBRATION_MAX_RATIO, Math.max(CALIBRATION_MIN_RATIO, observed / estimate))
}

/** One loaded session: a reload is a new session, whose template or tokenizer may differ. */
export function calibrationKey(target: CompactionTarget): string {
  return [target.provider, target.modelId, target.port, target.generation ?? ''].join('\0')
}

export class PromptCalibration {
  private readonly ratios = new Map<string, number>()

  constructor(private readonly maxSessions = MAX_CALIBRATED_SESSIONS) {}

  /** Learn from a request whose text estimate was `estimate` and whose engine counted `observed`. */
  learn(target: CompactionTarget, estimate: number, observed: number): void {
    const ratio = calibrationRatio(estimate, observed)
    if (ratio === undefined) return
    const key = calibrationKey(target)
    this.ratios.delete(key)
    if (this.ratios.size >= this.maxSessions) {
      const oldest = this.ratios.keys().next().value
      if (oldest !== undefined) this.ratios.delete(oldest)
    }
    this.ratios.set(key, ratio)
  }

  ratio(target: CompactionTarget): number | undefined {
    return this.ratios.get(calibrationKey(target))
  }

  /** `estimate` as the session would count it: by its learned ratio, else with the uncalibrated margin. */
  scale(target: CompactionTarget, estimate: number): number {
    return Math.ceil(estimate * (this.ratio(target) ?? UNCALIBRATED_MARGIN))
  }
}
