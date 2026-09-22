/** Who decided whether error reports are sent. */
export type ConsentSource = 'env' | 'host' | 'stored' | 'default'

const TRUTHY = new Set(['1', 'true', 'on', 'yes'])
const FALSY = new Set(['0', 'false', 'off', 'no'])

/**
 * What the environment says: `DO_NOT_TRACK` (the cross-tool convention) only ever turns reports off;
 * `ATOMIC_CORE_TELEMETRY` turns them on or off. Undefined when neither says anything.
 */
export function envConsent(env: NodeJS.ProcessEnv): boolean | undefined {
  const dnt = env['DO_NOT_TRACK']?.trim().toLowerCase()
  if (dnt && TRUTHY.has(dnt)) return false
  const own = env['ATOMIC_CORE_TELEMETRY']?.trim().toLowerCase()
  if (own && FALSY.has(own)) return false
  if (own && TRUTHY.has(own)) return true
  return undefined
}

/**
 * Whether reports are sent, and why. The core decides for itself, whoever embeds it: on unless
 * something says off. An "off" from the environment is the user's own and beats everything; after it
 * comes the host (the app's `productAnalytic` consent, `--telemetry`, `PUT /telemetry`), then an
 * environment "on", then what the user stored with `atomic-chat-core telemetry on|off`.
 */
export function resolveConsent(input: {
  env?: boolean | undefined
  host?: boolean | undefined
  stored?: boolean | undefined
}): { enabled: boolean; source: ConsentSource } {
  if (input.env === false) return { enabled: false, source: 'env' }
  if (input.host !== undefined) return { enabled: input.host, source: 'host' }
  if (input.env === true) return { enabled: true, source: 'env' }
  if (input.stored !== undefined) return { enabled: input.stored, source: 'stored' }
  return { enabled: true, source: 'default' }
}
