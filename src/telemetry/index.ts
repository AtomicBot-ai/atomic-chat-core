/**
 * Error reporting to the core's own Sentry project (`atomic-chat-core`), with the app's zero-PII
 * doctrine and its `productAnalytic` consent. See docs/decisions/*-report-core-errors-to-its-own-sentry-project.md.
 */
export * from './types.js'
export * from './config.js'
export * from './dsn.js'
export * from './scrub.js'
export * from './stack.js'
export * from './policy.js'
export * from './reports.js'
export * from './envelope.js'
export * from './reporter.js'
export * from './daemon.js'
export * from './subscribe.js'
