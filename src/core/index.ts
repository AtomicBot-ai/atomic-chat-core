/**
 * The `AtomicCore` facade: the owner process assembled from its parts. `create.ts` wires the
 * dependencies, `sessions.ts` owns model claims and routing to local sessions, `public-server.ts`
 * the lifecycle of the public `/v1` listener. Public API of this module is exported from this file only.
 */
export { CORE_VERSION } from '../version.js'
export { AtomicCore } from './atomic-core.js'
export type { PublicServerStartOptions } from './public-server.js'
export { LOCAL_PROVIDER } from './types.js'
export type { AtomicCoreOptions, CoreLoadOptions, CoreLogger } from './types.js'
