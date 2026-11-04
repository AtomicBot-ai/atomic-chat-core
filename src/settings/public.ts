/**
 * `@atomic-chat/core/settings`: the provider setting schemas for a program that embeds the core as a
 * library (`atc`), so it serves the descriptors of the very core it runs instead of reading JSON from
 * the package's sources (change close-cli-core-gaps, design D3). Only the schemas: the store in
 * `./index.ts` needs `node:fs` and stays internal.
 */

export { LOCAL_PROVIDER_IDS, settingsSchema } from './schema.js'
