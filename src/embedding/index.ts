/**
 * The embedding model: one stock llama.cpp `llama-server --embedding` that the public server's
 * `/v1/embeddings` forwards to when a client names it, with a projector for one that reads images or
 * audio. A module of its own, outside the sessions registry, like the decision model
 * (ADR 2026-10-07-embedding-models-are-their-own-core-module). Wire types in
 * `src/contracts/embedding.ts`; the catalog the app downloads from is `atomic-chat-conf/models/embedding.json`.
 */
export * from './args.js'
export * from './engine.js'
export * from './ffmpeg.js'
export * from './model-facts.js'
export * from './process.js'
export * from './readiness.js'
export * from './request.js'
export * from './service.js'
export * from './wiring.js'
