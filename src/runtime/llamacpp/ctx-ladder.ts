/**
 * The context-window ladder, ported from the app's `computeNextCtxLen`
 * (`core/src/browser/models/utils.ts`).
 *
 * When a request overflows the model's context the app does not fail it — it reloads the model with
 * a bigger window and retries. The steps are `<8192 → 8192 → 32768 → ×1.5`, capped at what the model
 * was trained for. They are not derived from anything; they are the steps the UI has always used,
 * and the ladder is shared so a session that grew under the app and one that grew under the core end
 * up at the same sizes.
 */

/**
 * The context window assumed when nothing else says otherwise. It was 16384, the single value the
 * app settled on after five different defaults disagreed across its tree; a coding agent's first
 * request alone is 13-27K tokens (Claude Code, OpenCode, Codex — integrations audit 2026-11-03, S4),
 * so 16K refused every agent. 32768 is the ladder's own next step. Small Macs are narrowed back
 * toward 16K by memory (`smallMemoryDefaultCtx`).
 */
export const DEFAULT_CTX_LEN = 32768

export function computeNextCtxLen(currentCtxLen: number, maxCtxLen?: number): number {
  let next: number
  if (currentCtxLen < 8192) next = 8192
  else if (currentCtxLen < 32768) next = 32768
  else next = Math.round(currentCtxLen * 1.5)
  if (typeof maxCtxLen === 'number' && maxCtxLen > 0) next = Math.min(next, maxCtxLen)
  return next
}
