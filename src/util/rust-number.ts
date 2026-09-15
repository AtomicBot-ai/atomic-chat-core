/**
 * Rust-compatible number parsing and formatting, shared by every port that has to reproduce
 * `str::parse::<T>()` and `T::to_string()` behaviour (argv floats, GGUF scalar stringification,
 * log-line parsers).
 */

/** `str::parse::<i32>()`: optional sign, digits only, in range. */
export function parseRustI32(s: string): number | undefined {
  if (!/^[+-]?\d+$/.test(s)) return undefined
  const n = Number(s)
  return n >= -2147483648 && n <= 2147483647 ? n : undefined
}

/** `str::parse::<u64>()`: optional `+`, digits only. Values above 2^53 lose precision. */
export function parseRustU64(s: string): number | undefined {
  if (!/^\+?\d+$/.test(s)) return undefined
  const big = BigInt(s)
  if (big > 18446744073709551615n) return undefined
  return Number(big)
}

/** `str::parse::<f64>()` for the shapes that matter: decimal, exponent, inf/infinity/nan. */
export function parseRustF64(s: string): number | undefined {
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return Number(s)
  const l = s.toLowerCase()
  if (l === 'inf' || l === '+inf' || l === 'infinity' || l === '+infinity') return Infinity
  if (l === '-inf' || l === '-infinity') return -Infinity
  if (l === 'nan' || l === '+nan' || l === '-nan') return NaN
  return undefined
}

/** Rewrite JS exponent notation into the plain decimal Rust's `Display` prints. */
export function expandExponent(s: string): string {
  if (!/e/i.test(s)) return s
  const [mantissa = '', expStr = '0'] = s.toLowerCase().split('e')
  const exp = Number(expStr)
  const negative = mantissa.startsWith('-')
  const unsigned = mantissa.replace('-', '')
  const digits = unsigned.replace('.', '')
  const pointIndex = (unsigned.split('.')[0] ?? '').length + exp
  let out: string
  if (pointIndex <= 0) out = '0.' + '0'.repeat(-pointIndex) + digits
  else if (pointIndex >= digits.length) out = digits + '0'.repeat(pointIndex - digits.length)
  else out = digits.slice(0, pointIndex) + '.' + digits.slice(pointIndex)
  return (negative ? '-' : '') + out
}

/**
 * `f32::to_string()`: shortest decimal that round-trips through f32, no exponent, integers
 * without a fractional part (`2.0 → "2"`), `inf` / `-inf` / `NaN` spelled as Rust does.
 * Values arriving as JSON doubles serialised from f32 are rounded through `Math.fround` first.
 */
export function formatRustF32(value: number): string {
  const f = Math.fround(value)
  if (Number.isNaN(f)) return 'NaN'
  if (f === Infinity) return 'inf'
  if (f === -Infinity) return '-inf'
  for (let precision = 1; precision <= 9; precision++) {
    const candidate = Number(f.toPrecision(precision))
    if (Math.fround(candidate) === f) return expandExponent(candidate.toString())
  }
  return expandExponent(f.toString())
}

/** `f64::to_string()`: JS already prints the shortest round-trip; only the spelling differs. */
export function formatRustF64(value: number): string {
  if (Number.isNaN(value)) return 'NaN'
  if (value === Infinity) return 'inf'
  if (value === -Infinity) return '-inf'
  return expandExponent(value.toString())
}

const F32_EPSILON = 1.1920929e-7

/** `(a - b).abs() > f32::EPSILON` evaluated in f32 as Rust does. */
export function f32Differs(a: number, b: number): boolean {
  return Math.abs(Math.fround(Math.fround(a) - Math.fround(b))) > F32_EPSILON
}

/** `(v) as u64` on a float: NaN → 0, negative → 0, truncates; saturates at MAX_SAFE_INTEGER. */
export function floatAsU64(v: number): number {
  if (Number.isNaN(v) || v <= 0) return 0
  if (v >= Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER
  return Math.trunc(v)
}

/** `a.saturating_sub(b)` on u64. */
export function saturatingSub(a: number, b: number): number {
  return a > b ? a - b : 0
}
