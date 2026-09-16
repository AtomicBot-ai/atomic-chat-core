/**
 * Narrowing helpers for the parsed JSON the agent-config writers edit in place.
 *
 * The Rust writers all work on `serde_json::Value` and repair a field whose type does not match
 * what they need (`if !provider.is_object() { *provider = json!({}) }`). Reproducing that needs the
 * same question asked the same way in TypeScript: "is this an object?" must exclude arrays and
 * `null`, both of which `typeof x === 'object'` accepts.
 */

import type { JsonValue } from '../config-io.js'

export type JsonObject = { [key: string]: JsonValue }

/** The value as a JSON object, or `undefined` for anything else (`null` and arrays included). */
export function asJsonObject(value: unknown): JsonObject | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as JsonObject
}

/** The value as a JSON array, or `undefined` for anything else. */
export function asJsonArray(value: unknown): JsonValue[] | undefined {
  return Array.isArray(value) ? (value as JsonValue[]) : undefined
}
