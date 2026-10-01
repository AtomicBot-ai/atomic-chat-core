/**
 * Session port selection and the per-session API key. Port of `generate_random_port` in
 * `src-tauri/utils/src/network.rs` and `generate_api_key` in the plugin's `commands.rs`.
 */

import { createHmac, randomInt } from 'node:crypto'
import { createServer } from 'node:net'

export const PORT_RANGE_MIN = 3000
export const PORT_RANGE_MAX = 4000 // exclusive
export const PORT_MAX_ATTEMPTS = 20000
export const PORT_EXHAUSTED_MESSAGE = 'Failed to find an available port for the model to load'

/**
 * Ports `fetch` refuses to connect to ("bad port", WHATWG Fetch §2.9: undici, browsers and
 * WebViews all apply it). A server on one of these is unreachable from any `fetch` client, so it is
 * never handed out. Only 3659 falls in the default range; the full list keeps custom ranges safe.
 */
export const FETCH_BLOCKED_PORTS: ReadonlySet<number> = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104,
  109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515,
  526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049,
  3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
])

/** Bind-and-release probe on 127.0.0.1 (inherently racy, as in the original). */
export function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

export interface PortOptions {
  min?: number
  max?: number
  attempts?: number
  random?: (min: number, max: number) => number
  isAvailable?: (port: number) => Promise<boolean>
}

/** A random port in [3000, 4000) that no session uses and that binds. */
export async function randomFreePort(usedPorts: Iterable<number>, opts: PortOptions = {}): Promise<number> {
  const used = new Set(usedPorts)
  const min = opts.min ?? PORT_RANGE_MIN
  const max = opts.max ?? PORT_RANGE_MAX
  const attempts = opts.attempts ?? PORT_MAX_ATTEMPTS
  const random = opts.random ?? ((lo, hi) => randomInt(lo, hi))
  const isAvailable = opts.isAvailable ?? isPortAvailable
  for (let i = 0; i < attempts; i++) {
    const port = random(min, max)
    if (used.has(port) || FETCH_BLOCKED_PORTS.has(port)) continue
    if (await isAvailable(port)) return port
  }
  throw new Error(PORT_EXHAUSTED_MESSAGE)
}

/** Secret the extension has always used for session keys (`index.ts:531`). */
export const DEFAULT_API_SECRET = 'JustAskNow'

/**
 * base64(HMAC-SHA256(secret, modelId + port)) — what the process gets as `LLAMA_API_KEY`. The
 * extension concatenates the port onto the model id before calling the Rust HMAC (`index.ts:3195`).
 */
export function generateApiKey(
  modelId: string,
  port: number | string,
  secret: string = DEFAULT_API_SECRET
): string {
  return createHmac('sha256', secret).update(`${modelId}${port}`).digest('base64')
}
