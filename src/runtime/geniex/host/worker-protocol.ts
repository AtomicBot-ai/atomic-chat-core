/**
 * What the Worker of `geniex-host` does with each message of the main thread (openspec change
 * `add-geniex-runtime`, design D1), apart from the thread it runs on: `worker.ts` is the Bun entry
 * that binds this to `self.onmessage` with the `bun:ffi` library, and the tests drive it in-process
 * with a fake library.
 *
 * The library is single-threaded and `generate` blocks: the Worker handles one message at a time,
 * and while a generation runs it reads nothing — the main thread cancels through the shared flag the
 * generate message carries, which the token callback checks on every token.
 */

import { GENIEX_CANCELLED, GeniexLibraryError, PROBE_PLUGIN } from './library.js'
import type {
  GeniexGenerateResult,
  GeniexGenerationConfig,
  GeniexLibrary,
  GeniexModel,
  GeniexModelSettings,
  GeniexTemplateInput,
  LoadGeniexLibrary,
} from './library.js'

/** Main thread → Worker. */
export type GeniexWorkerRequest =
  | { type: 'probe'; libDir: string }
  | { type: 'create'; libDir: string; settings: GeniexModelSettings }
  | { type: 'template'; id: number; input: GeniexTemplateInput }
  | {
      type: 'generate'
      id: number
      prompt: string
      config: GeniexGenerationConfig
      /** One `Int32`; non-zero asks the token callback to stop. */
      cancel: SharedArrayBuffer
    }
  | { type: 'destroy' }

/** Worker → main thread. */
export type GeniexWorkerAnswer =
  | { type: 'probed'; version: string | null; abi: number; plugins: string[]; devices: string[] }
  | { type: 'created'; vision: boolean }
  | { type: 'templated'; id: number; prompt: string }
  | { type: 'token'; id: number; text: string }
  | { type: 'done'; id: number; result: GeniexGenerateResult }
  | { type: 'error'; id: number; message: string; code: number | null }
  | { type: 'destroyed' }
  /** `probe` or `create` failed: `load` — the library did not open; `call` — it refused. */
  | { type: 'failed'; stage: 'load' | 'call'; message: string; code: number | null }

export interface GeniexWorkerDeps {
  loadLibrary: LoadGeniexLibrary
  post: (answer: GeniexWorkerAnswer) => void
}

const failure = (error: unknown): { message: string; code: number | null } => ({
  message: error instanceof Error ? error.message : String(error),
  code: error instanceof GeniexLibraryError ? error.code : null,
})

/** One Worker's state machine: a library once loaded, a model once created. */
export function createGeniexWorkerHandler(
  deps: GeniexWorkerDeps
): (request: GeniexWorkerRequest) => Promise<void> {
  let library: GeniexLibrary | null = null
  let model: GeniexModel | null = null

  const load = async (libDir: string): Promise<GeniexLibrary | null> => {
    if (library) return library
    try {
      library = await deps.loadLibrary(libDir)
      return library
    } catch (error) {
      deps.post({ type: 'failed', stage: 'load', ...failure(error) })
      return null
    }
  }

  return async (request) => {
    switch (request.type) {
      case 'probe': {
        const lib = await load(request.libDir)
        if (!lib) return
        try {
          deps.post({
            type: 'probed',
            version: lib.version,
            abi: lib.abi,
            plugins: lib.plugins(),
            devices: lib.devices(PROBE_PLUGIN),
          })
        } catch (error) {
          deps.post({ type: 'failed', stage: 'call', ...failure(error) })
        }
        return
      }
      case 'create': {
        const lib = await load(request.libDir)
        if (!lib) return
        try {
          model = lib.createModel(request.settings)
          deps.post({ type: 'created', vision: model.vision })
        } catch (error) {
          deps.post({ type: 'failed', stage: 'call', ...failure(error) })
        }
        return
      }
      case 'template': {
        if (!model) return deps.post({ type: 'error', id: request.id, message: 'no model', code: null })
        try {
          deps.post({ type: 'templated', id: request.id, prompt: model.applyChatTemplate(request.input) })
        } catch (error) {
          deps.post({ type: 'error', id: request.id, ...failure(error) })
        }
        return
      }
      case 'generate': {
        if (!model) return deps.post({ type: 'error', id: request.id, message: 'no model', code: null })
        const flag = new Int32Array(request.cancel)
        try {
          const result = model.generate(request.prompt, request.config, (token) => {
            if (Atomics.load(flag, 0) !== 0) return false
            deps.post({ type: 'token', id: request.id, text: token })
            return true
          })
          deps.post({ type: 'done', id: request.id, result })
        } catch (error) {
          if (error instanceof GeniexLibraryError && error.code === GENIEX_CANCELLED)
            deps.post({
              type: 'done',
              id: request.id,
              result: { stopReason: 'cancelled', promptTokens: 0, generatedTokens: 0 },
            })
          else deps.post({ type: 'error', id: request.id, ...failure(error) })
        }
        return
      }
      case 'destroy': {
        try {
          model?.destroy()
          model = null
          library?.close()
          library = null
        } finally {
          deps.post({ type: 'destroyed' })
        }
        return
      }
    }
  }
}
