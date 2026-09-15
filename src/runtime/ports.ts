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
    if (used.has(port)) continue
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
