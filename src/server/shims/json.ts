/** JSON values as the shims pass them around: request and response bodies decoded from the wire. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// ── serde_json `Value::to_string()` ─────────────────────────────────────────────────────────────

/** Compare by Unicode code point, which is the UTF-8 byte order a Rust `BTreeMap<String, _>` uses. */
function compareCodePoints(a: string, b: string): number {
  const ai = a[Symbol.iterator]()
  const bi = b[Symbol.iterator]()
  for (;;) {
    const x = ai.next()
    const y = bi.next()
    // Object keys are distinct, so the two never run out together: the shorter one sorts first.
    if (x.done || y.done) return x.done ? -1 : 1
    const d = (x.value.codePointAt(0) as number) - (y.value.codePointAt(0) as number)
    if (d !== 0) return d
  }
}

const U64_MAX = 18446744073709551615n
const I64_MIN = -9223372036854775808n

/**
 * A JSON number as serde_json prints it. An integral value in u64/i64 range is taken to have been
 * an integer literal and printed as one; anything else is an f64 printed the way the `ryu` crate
 * does (`1.5`, `1e21`, `1e-7`, `-0.0`). Both engines pick the shortest round-trip digits, so only
 * the layout differs from JS.
 */
function rustNumber(n: number): string {
  if (Number.isInteger(n) && !Object.is(n, -0)) {
    const big = BigInt(n)
    if (big >= I64_MIN && big <= U64_MAX) return big.toString()
  }
  if (!Number.isFinite(n)) return 'null' // serde_json writes non-finite floats as null
  // Positive zero is an integer and printed above; only negative zero gets here.
  if (n === 0) return '-0.0'

  const sign = n < 0 ? '-' : ''
  const [mantissa, expText] = Math.abs(n).toExponential().split('e') as [string, string]
  const digits = mantissa.replace('.', '')
  const length = digits.length
  const kk = Number(expText) + 1 // value = 0.digits × 10^kk

  // An integral value below 10^16 is always within i64 and was printed as an integer above, so every
  // value that reaches the fixed-point layout has a fractional part.
  let body: string
  if (kk > 0 && kk <= 16) {
    body = `${digits.slice(0, kk)}.${digits.slice(kk)}`
  } else if (kk > -5 && kk <= 0) {
    body = `0.${'0'.repeat(-kk)}${digits}`
  } else if (length === 1) {
    body = `${digits}e${kk - 1}`
  } else {
    body = `${digits[0]}.${digits.slice(1)}e${kk - 1}`
  }
  return sign + body
}

/** serde_json's compact `Value::to_string()` (without `preserve_order`: object keys sorted). */
export function serdeToString(value: JsonValue): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return rustNumber(value)
  // serde_json and JSON.stringify escape strings identically for anything JSON.parse can produce
  // that serde_json would also have accepted.
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(serdeToString).join(',')}]`
  const keys = Object.keys(value).sort(compareCodePoints)
  return `{${keys.map((k) => `${JSON.stringify(k)}:${serdeToString(value[k] as JsonValue)}`).join(',')}}`
}
