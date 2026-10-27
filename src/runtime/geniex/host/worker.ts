/**
 * The Worker of `geniex-host` (openspec change `add-geniex-runtime`, design D1): the one thread that
 * calls Qualcomm's library. Bundled as its own entry of the compiled binaries; allow-listed with
 * `ffi-bun.ts` in the runtime-agnostic gates, since the Worker globals and `bun:ffi` are Bun's.
 */

import { loadBunGeniexLibrary } from './ffi-bun.js'
import { createGeniexWorkerHandler } from './worker-protocol.js'
import type { GeniexWorkerAnswer, GeniexWorkerRequest } from './worker-protocol.js'

declare const self: {
  onmessage: ((event: { data: unknown }) => void) | null
  postMessage(message: GeniexWorkerAnswer): void
}

const handle = createGeniexWorkerHandler({
  loadLibrary: loadBunGeniexLibrary,
  post: (answer) => self.postMessage(answer),
})

// One message at a time: `generate` blocks this thread anyway, and the library is not thread-safe.
let tail: Promise<void> = Promise.resolve()
self.onmessage = (event) => {
  const request = event.data as GeniexWorkerRequest
  tail = tail.then(() => handle(request))
}
