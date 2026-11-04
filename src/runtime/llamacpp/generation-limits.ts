/**
 * The limits core starts llama-server with when the settings leave them to it: how long one answer
 * may run, how long a thinking model may think, and how much RAM the prompt cache may hold.
 *
 * llama.cpp b12019 sets none of them: `n_predict` is -1, "no limit" (`common/common.h:458`), the
 * reasoning budget -1, "unrestricted" (`common/arg.cpp:3715`), and the host prompt cache 8192 MiB
 * (`common/common.h:644`). A client that sends no `max_tokens` (Codex through the Responses shim,
 * Kilo, OpenCode) then generates until the context window is full; a request's own `max_tokens`
 * still wins over `--n-predict` (`tools/server/server-context.cpp:2096`), and a request's own
 * `reasoning_budget_tokens` / Anthropic `thinking.budget_tokens` over `--reasoning-budget`
 * (`tools/server/server-common.cpp:1519-1523`), so these only bound the requests that bound nothing.
 */

const GiB = 1024 ** 3

/**
 * The answer cap a load gets when `n_predict` is left at 0 (automatic): long enough for a whole file
 * an agent writes in one turn, short enough that a runaway generation ends in minutes, not when the
 * window is full. Never above the window the load runs with.
 */
export const DEFAULT_N_PREDICT = 16_384

/**
 * The thinking budget the settings ship with (`reasoning_budget`): half of the answer cap, so a
 * thinking model that uses all of it still has room left to answer.
 */
export const DEFAULT_REASONING_BUDGET = 8_192

/**
 * What llama.cpp injects before the end-of-thinking tag when the budget runs out
 * (`--reasoning-budget-message`, `common/arg.cpp:3723`), so the model answers from what it has
 * instead of stopping mid-thought. Qwen's own wording for a cut-off thought.
 */
export const REASONING_BUDGET_MESSAGE =
  'Considering the limited time, I have to give the solution based on the thinking directly now.'

/** At or below this much RAM the host prompt cache is narrowed (`promptCacheRamMiB`). */
export const SMALL_HOST_MEMORY_BYTES = 16 * GiB

/**
 * `--cache-ram` on a machine with at most 16 GiB of RAM, or `undefined` to keep llama.cpp's 8192 MiB.
 * The cache lives in host RAM (`tools/server/server-context.cpp:1594-1602`) — on Apple silicon the
 * same RAM the model's weights and KV cache are wired into — and on an 8 or 16 GiB machine 8 GiB of
 * saved prompts pushes the rest of the system into swap. 1 GiB up to 8 GiB of RAM, 2 GiB up to 16:
 * still several agent prompts of a small model, which is what the cache is for between turns.
 */
export function promptCacheRamMiB(totalMemoryBytes: number | undefined): number | undefined {
  if (totalMemoryBytes === undefined || !(totalMemoryBytes > 0)) return undefined
  if (totalMemoryBytes > SMALL_HOST_MEMORY_BYTES) return undefined
  return totalMemoryBytes > 8 * GiB ? 2048 : 1024
}

/**
 * The `--n-predict` a load is started with. `0` is automatic: {@link DEFAULT_N_PREDICT}, never above
 * `windowTokens` (the window the load runs with when core knows it). `-1` (or any negative value) is
 * the user's explicit "no limit" and passes nothing; a positive value is the user's own cap.
 */
export function resolveNPredict(setting: number, windowTokens: number | undefined): number {
  if (!Number.isFinite(setting) || setting < 0) return -1
  if (setting > 0) return Math.floor(setting)
  return windowTokens !== undefined && windowTokens > 0
    ? Math.min(DEFAULT_N_PREDICT, windowTokens)
    : DEFAULT_N_PREDICT
}
