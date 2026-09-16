/**
 * Single-owner coordination for a data folder: the instance lock and its process-start identity,
 * the control token, and the journal of spawned backend processes. PLAN.md §3.4, §3.6.
 */
export * from './process-identity.js'
export * from './instance-lock.js'
export * from './control-token.js'
export * from './process-journal.js'
export * from './legacy-guard.js'
export * from './model-claim.js'
