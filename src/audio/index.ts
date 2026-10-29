/**
 * Audio generation on audio.cpp: speech, music and sound effects from text. One resident
 * `audiocpp_server` per loaded model, the builds it runs from, and the clips on disk. A module of its
 * own beside image generation (`src/diffusion/`), not a local runtime.
 */
export * from './errors.js'
export * from './install.js'
