/**
 * Remote media: the image and video models cloud providers and self-hosted servers offer through the
 * core (ADR 2026-10-13-remote-media-shares-the-diffusion-job-table). The catalog (conf
 * `providers/media.json`), one adapter per provider media API, and the service that resolves a
 * provider's model for the job runner in `src/diffusion/remote-job.ts`.
 */
export * from './adapters/types.js'
export * from './catalog.js'
export * from './catalog-baseline.js'
export * from './catalog-service.js'
export * from './http.js'
export * from './mask.js'
export * from './service.js'
export * from './adapters/registry.js'
