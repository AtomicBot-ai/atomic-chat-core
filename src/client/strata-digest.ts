import { parseStrataDescriptor } from './strata-contracts.js'

/** Sorted object keys, preserved array order, UTF-8 JSON without whitespace or trailing newline. */
export function strataCanonicalDescriptor(raw: unknown): string {
  const descriptor = parseStrataDescriptor(raw)
  function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical)
    if (value !== null && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => [k, canonical(v)])
      )
    return value
  }
  return JSON.stringify(canonical(descriptor))
}

/** The browser and core use the same digest; it includes capability and recipe metadata as well as files. */
export async function strataSourceDigest(raw: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(strataCanonicalDescriptor(raw))
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
