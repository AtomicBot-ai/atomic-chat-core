/**
 * History compaction: when a chat no longer fits the window its session serves, its oldest turns are
 * summarized by the same loaded model and replaced by the summary, instead of reloading the model.
 * Works on every local engine that serves chat completions; counts prompts exactly where the engine
 * can (llama.cpp, a declared chat `/tokenize`) and by a calibrated estimate elsewhere.
 *
 * Used by the control API (`POST /models/:provider/*modelId/{context/measure,compact}`) and by the
 * public server's `/chat/completions`. Pure policy (`estimate`, `calibration`, `plan`, `cache` keys,
 * the prompt and answer shapes in `summarize`) is apart from the I/O (`count`, `summarizeHistory`).
 */
export * from './cache.js'
export * from './calibration.js'
export * from './compact.js'
export * from './count.js'
export * from './engine.js'
export * from './estimate.js'
export * from './measure.js'
export * from './plan.js'
export * from './request.js'
export * from './summarize.js'
