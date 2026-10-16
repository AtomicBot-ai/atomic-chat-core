/**
 * The part of Foundry Local's C API (`foundry_local_c.h`, `FOUNDRY_LOCAL_API_VERSION` 2) the host
 * uses, as an interface. `ffi-bun.ts` implements it over `bun:ffi`; the protocol tests (tasks 5.2,
 * 5.3) run the host against a fake one. Every call is synchronous and may block, like the C API.
 */

/** A non-null `flStatus*`: the library's error code and message. */
export class FoundryLibraryError extends Error {
  constructor(
    readonly operation: string,
    readonly libraryCode: number,
    message: string
  ) {
    super(`${operation}: ${message}`)
    this.name = 'FoundryLibraryError'
  }
}

export interface FoundryManagerConfig {
  appName: string
  appDataDir: string
  logsDir: string
  modelCacheDir: string
  /** `http://127.0.0.1:<port>` for `serve`; none otherwise. */
  webServiceEndpoints: string[]
  /** `SetAdditionalOptions`, e.g. `DisableNonessentialTelemetry`. */
  additionalOptions: Record<string, string>
}

export interface DiscoverableEp {
  name: string
  /** Registered in this process; says nothing about a previous process (spike finding 18). */
  registered: boolean
}

export interface ModelMetadata {
  strings: Record<string, string>
  ints: Record<string, number>
}

export interface FoundryModel {
  load(): void
  unload(): void
  /** The model's execution provider as the library holds it; `null` when unset. */
  executionProvider(): string | null
}

export interface FoundryManager {
  discoverableEps(): DiscoverableEp[]
  /**
   * `Manager_DownloadAndRegisterEps`, blocking. `onProgress` is called on the calling thread for
   * CDN accelerators (spike findings 2, 15). Windows ML ones may call it from a thread of their own
   * on a first install, where the plain callback cannot run: pass it only for CDN accelerators. A
   * per-EP failure is not an error — read `discoverableEps()` afterwards.
   */
  downloadAndRegisterEps(names: string[], onProgress?: (ep: string, percent: number) => void): void
  /** `RegisterModel` in the local catalog; files are not copied. */
  registerLocalModel(path: string, id: string, metadata: ModelMetadata): FoundryModel
  /** Start the built-in server; the bound URLs. */
  webServiceStart(): string[]
  shutdown(): void
  release(): void
}

export interface FoundryLibrary {
  /** `FoundryLocalGetVersionString`. */
  version: string
  /** The C API version the table was requested at. */
  cApiVersion: number
  createManager(config: FoundryManagerConfig): FoundryManager
}

/** Opens the library of one build (`<build>/lib`); throws when it does not load or speaks another C API. */
export type LoadFoundryLibrary = (libDir: string) => Promise<FoundryLibrary>
