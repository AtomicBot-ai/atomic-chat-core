/**
 * The seam between the engine-neutral managed-text lifecycle (`lifecycle.ts`) and one containerized
 * engine (openspec change `add-tensorrt-llm-linux`, task 2.12; the TensorRT-LLM adapter is task 2.13).
 *
 * An adapter is compiled into core and looked up by the `adapter_id` a pinned runtime descriptor
 * names — never loaded from metadata. Everything engine-specific the lifecycle needs goes through
 * this interface: the engine's argv and port, how to tell it is ready, which log lines mark its
 * progress, how long it may take, and what its exit meant. The lifecycle itself holds no
 * `engine_id` branch anywhere; a second engine is a second adapter, not an `if`.
 */
import { AtomicCoreError } from '../../contracts/index.js'
import type { ModelFamilySupport, SessionLoadStage } from '../../contracts/index.js'
import type { EngineLaunchSpec } from './types.js'

/** The adapter contract this core implements; a descriptor's `adapter_contract_version` must match. */
export const MANAGED_TEXT_ADAPTER_CONTRACT_VERSION = 1

/**
 * The load stages an engine's own log can move a load into. `stopping-previous` and `ready` belong
 * to the lifecycle alone: the first happens before any container exists, the second only once the
 * readiness probe answers.
 */
export type EngineLoadStage = Extract<SessionLoadStage, 'starting-container' | 'initializing-engine'>

/**
 * A log line that tells the lifecycle the engine reached `stage`. With no markers the lifecycle moves
 * to `initializing-engine` as soon as the container starts; with markers it stays in
 * `starting-container` until one of them shows up in the container's log.
 */
export interface ManagedStageMarker {
  stage: EngineLoadStage
  pattern: RegExp
}

/** An HTTP GET against the engine's server root that answers `expectedStatus` once it can serve. */
export interface ManagedReadinessProbe {
  /** Absolute path, no query, no `..`: joined onto the internal `BackendTarget`, never a full URL. */
  path: string
  /** A 2xx status. A redirect is never readiness: the probe does not follow redirects at all. */
  expectedStatus: number
}

/** What an adapter is told when it builds a launch. Container paths are fixed by the executor. */
export interface ManagedLaunchContext<S> {
  modelId: string
  settings: S
  /** The model directory as the container sees it, mounted read-only. */
  modelPath: string
  /** The engine cache directory as the container sees it, mounted read-write and kept across loads. */
  engineCachePath: string
  /**
   * This generation's own directory as the container sees it, mounted read-only: where the launch's
   * `files` land (beside the watchdog's heartbeat file), and gone with the generation.
   */
  generationFilesPath: string
  weightBytes: number
  /** The pinned descriptor's `model_families` entry for this model's architecture, or null. */
  family: ModelFamilySupport | null
}

export interface ManagedEngineLaunch {
  engine: EngineLaunchSpec
  /** The engine's own argv. The container runs `<watchdog entrypoint> -- <argv>`. */
  argv: string[]
  /** Engine env vars; the watchdog's own `ATOMIC_WATCHDOG_*` vars are the lifecycle's and win. */
  env?: Record<string, string>
  /**
   * Files the lifecycle writes, before the container is created, into this generation's read-only
   * directory (`ManagedLaunchContext.generationFilesPath` inside the container), keyed by a bare file
   * name — e.g. an engine's option file its argv points at. Core writes them, so nothing the
   * container runs can change them; the name `heartbeat` is the watchdog's and is refused.
   */
  files?: Readonly<Record<string, string>>
}

export type ManagedExitKind = 'out-of-memory' | 'unsupported-model' | 'other'

/** What an engine's exit meant, read from its log (the whole log before readiness) and exit code. */
export interface ManagedExitClassification {
  kind: ManagedExitKind
  /** Human wording, including whatever numbers the log gave (e.g. requested vs. free memory). */
  message: string
  /** The numbers behind `message`, for a caller that wants to render them itself. */
  numbers?: Record<string, number>
  /**
   * The log lines that decided this classification. The lifecycle puts them ahead of the log tail in
   * the error's details when they are not already in it, so a line a long traceback pushed out of the
   * tail still reaches the user.
   */
  excerpt?: string
}

/** What a loaded model can do through this engine (spec `tensorrt-llm-runtime`, design D9). */
export interface ManagedTextCapabilities {
  tools: boolean
  reasoning: boolean
  structured_output: boolean
  vision: boolean
  embeddings: boolean
  responses: boolean
}

/**
 * One route this engine serves through the session gateway: method and path together
 * (findings-2.13-r3.md item 1). Path alone is not enough to declare a route — a path match with the
 * wrong method must still be refused (`405`), not silently forwarded, or `GET /v1/chat/completions`
 * would reach the upstream just because the *path* `/v1/chat/completions` happens to be declared for
 * `POST`. `method` is compared to `IncomingMessage.method` exactly as Node reports it (always
 * upper-case for a real request; a fake source in a test should match that). `HEAD` is never implied
 * by a declared `GET` route — an adapter that wants to serve `HEAD` declares it explicitly; the
 * default (nothing declares it) is a `405`, which is the correct, safe answer for a route that has
 * no `HEAD` handler of its own.
 */
export interface ManagedRoute {
  method: string
  /** Absolute path, no query, no `..`: the same shape a readiness path is held to. */
  path: string
}

/**
 * One containerized text engine. `S` is the adapter's own validated settings shape; the lifecycle
 * treats it as opaque and only ever hands back what `validateSettings` returned.
 */
export interface ManagedTextAdapter<S = unknown> {
  /** Matches the descriptor's `adapter_id`. */
  readonly id: string
  /** Matches the descriptor's `adapter_contract_version`. */
  readonly contractVersion: number
  readonly readiness: ManagedReadinessProbe
  readonly stageMarkers: readonly ManagedStageMarker[]
  /**
   * Every method+path this engine serves through the session gateway. A path with no matching
   * method gets `404` from the gateway; a path that *is* declared, but not for the method the
   * request used, gets `405` with an `Allow` header — neither is ever forwarded upstream
   * (findings-2.13-r2.md item 3, keyed on method+path since findings-2.13-r3.md item 1: path alone
   * let `GET`/`PUT`/`DELETE /v1/chat/completions` and `POST`/`DELETE`/`HEAD`/`OPTIONS /v1/models`
   * all reach the upstream). This is what closes off an engine's own undocumented or administrative
   * routes (e.g. `trtllm-serve`'s `/update_weights`, `/release_memory`) that were never meant to be
   * reachable from outside the container. The readiness path (`readiness.path` above) is
   * deliberately not part of this list — the lifecycle probes it directly against the container's
   * own port, never through the gateway a caller's traffic goes over.
   */
  readonly routes: readonly ManagedRoute[]
  /**
   * The subset of `routes` whose request body `rewriteRequestBody` may rewrite — each entry must
   * also appear in `routes` (checked at registration). Every other declared route (and every
   * undeclared or wrong-method one, which never gets this far) streams through byte-for-byte: no
   * JSON parsing, no re-serialization. Absent or empty when `rewriteRequestBody` is not defined at
   * all.
   */
  readonly rewritableRoutes?: readonly ManagedRoute[]
  /** Throws `AtomicCoreError('INVALID_ARGUMENT', ...)` before any container exists. */
  validateSettings(raw: unknown): S
  buildLaunch(context: ManagedLaunchContext<S>): ManagedEngineLaunch
  /** How long readiness may take for this much weight, with margin; a provider setting overrides it. */
  readinessTimeoutMs(weightBytes: number, settings: S): number
  /**
   * Why the engine exited. Before readiness `log` is the container's whole log (bounded by the docker
   * exec's output cap), so a decisive line far above the last one still counts; after a crash of a
   * ready session it is the log tail.
   */
  classifyExit(log: string, exitCode: number | null): ManagedExitClassification
  capabilities(context: { settings: S; family: ModelFamilySupport | null }): ManagedTextCapabilities
  /**
   * Optional: rewrites a JSON POST request body before the session gateway forwards it upstream
   * (`../managed-text/gateway.ts`'s `startManagedGateway`; see
   * `docs/decisions/2026-09-28-tensorrt-llm-output-cap-enforced-by-the-session-gateway.md` for why
   * this exists at all — most engines need no request-side rewriting and should leave it undefined,
   * and `rewritableRoutes` empty/absent). `route` is the request path with no query string, decoded
   * and already matched — method and path together — against `routes` by the gateway. The gateway
   * calls this only for a request whose method+path is listed in `rewritableRoutes`, only with a
   * non-empty body, under a byte cap enforced while the body streams in (over it answers `413`
   * before this is even called, without buffering the rest), and only once the body parses as JSON
   * (a parse failure answers `400` without calling this or reaching the upstream). This may throw to
   * reject the request outright — e.g. a client-supplied value that is present but not usable — and
   * must not silently substitute a different value for something invalid and forward that instead.
   * Throw `AtomicCoreError('INVALID_ARGUMENT', message)` for that: the gateway surfaces its
   * `message` verbatim as an OpenAI-shaped `400`, since that text was written to be read by the
   * client whose request it rejects; a `ManagedRequestRefusal` (below) also chooses the OpenAI `code`,
   * e.g. `unsupported_capability` for what `capabilities` — this session's own, bound by the lifecycle —
   * says the model cannot do (findings-2.14-r1.md item 1). Any other throw (a bug in this hook itself, not a rejection of
   * the client's input) becomes a generic `500` instead — the gateway does not assume an arbitrary
   * thrown value's `message` is safe to show a client (findings-2.13-r3.md item 3). The response
   * stream is never touched by this hook, on any route, streamed or not.
   */
  rewriteRequestBody?(
    route: string,
    body: unknown,
    settings: S,
    capabilities: ManagedTextCapabilities
  ): unknown
  /**
   * Optional (task 2.14 fix round 1, findings-2.14-r1.md item 1): the OpenAI error body a client gets
   * for an engine's own error answer on a declared POST route, or `null` to relay the engine's answer
   * as it is. The gateway calls this only for a non-2xx answer, reads that answer under a small cap
   * (`MANAGED_GATEWAY_ERROR_BODY_CAP_BYTES`) to do so, and never touches a 2xx answer — streamed or
   * not. What an engine needs here is a translation of its own error wording into the one clients
   * already handle (`context_length_exceeded` for `trtllm-serve`'s context overflow).
   */
  mapErrorResponse?(route: string, status: number, body: string): object | null
  /**
   * Optional: the part of the validated settings a running container was started with. A later load
   * of the same model whose settings differ only outside this part joins the running session (with
   * the new settings in force for what the gateway enforces per request) instead of restarting a
   * container (findings-2.14-r1.md item 3). Absent, every setting counts.
   */
  restartKey?(settings: S): unknown
}

/**
 * What a request-side hook (`rewriteRequestBody`) throws to refuse a request with a specific OpenAI
 * error `code` — e.g. `unsupported_capability` for `tools` sent to a model with no tool-call parser.
 * The gateway answers it as `400 {"error": {message, type: 'invalid_request_error', code}}`, the same
 * envelope `:1337` uses, so a client sees one shape whichever port it talks to.
 */
export class ManagedRequestRefusal extends AtomicCoreError {
  readonly openaiCode: string

  constructor(message: string, openaiCode: string) {
    super('INVALID_ARGUMENT', message)
    this.name = 'ManagedRequestRefusal'
    this.openaiCode = openaiCode
  }
}

const READINESS_PATH = /^\/(?!\/)[A-Za-z0-9._~/-]*$/

function invalid(message: string, detail: string): never {
  throw new AtomicCoreError('INVALID_ARGUMENT', message, detail)
}

/** Same shape a readiness path must have; a declared route is held to the same rule. */
function assertRoutePath(path: string, what: string): void {
  if (!READINESS_PATH.test(path) || path.split('/').some((segment) => segment === '..')) {
    invalid(`${what} is not an absolute path with no query, fragment or \`..\`.`, path)
  }
}

function assertAdapterShape(adapter: ManagedTextAdapter): void {
  if (adapter.id === '') invalid('A managed text adapter needs an id.', adapter.id)
  if (!Number.isInteger(adapter.contractVersion) || adapter.contractVersion < 1) {
    invalid('A managed text adapter contract version is a positive integer.', String(adapter.contractVersion))
  }
  const { path, expectedStatus } = adapter.readiness
  assertRoutePath(path, 'A readiness path')
  if (!Number.isInteger(expectedStatus) || expectedStatus < 200 || expectedStatus > 299) {
    invalid('A readiness probe expects a 2xx status.', String(expectedStatus))
  }
  if (adapter.routes.length === 0) {
    invalid('A managed text adapter needs at least one declared route.', adapter.id)
  }
  for (const route of adapter.routes) {
    if (route.method === '') invalid('A declared route needs a method.', route.path)
    assertRoutePath(route.path, 'A declared route')
  }
  const isDeclared = (route: ManagedRoute) =>
    adapter.routes.some((r) => r.method === route.method && r.path === route.path)
  for (const route of adapter.rewritableRoutes ?? []) {
    if (!isDeclared(route)) {
      invalid('A rewritable route must also be a declared route.', `${route.method} ${route.path}`)
    }
  }
}

/** The adapters compiled into this core, keyed by `adapter_id`. */
export class ManagedTextAdapterRegistry {
  private readonly adapters = new Map<string, ManagedTextAdapter>()

  register(adapter: ManagedTextAdapter): void {
    assertAdapterShape(adapter)
    if (this.adapters.has(adapter.id)) {
      invalid('A managed text adapter with this id is already registered.', adapter.id)
    }
    this.adapters.set(adapter.id, adapter)
  }

  has(adapterId: string): boolean {
    return this.adapters.has(adapterId)
  }

  ids(): string[] {
    return [...this.adapters.keys()]
  }

  /**
   * The adapter a pinned descriptor asks for. An id this core does not know, or a contract version
   * it does not implement, is `MANAGED_ADAPTER_UNAVAILABLE`: the installation cannot be served by
   * this core, whatever the descriptor says.
   */
  resolve(adapterId: string, contractVersion?: number): ManagedTextAdapter {
    const adapter = this.adapters.get(adapterId)
    if (adapter === undefined) {
      throw new AtomicCoreError(
        'MANAGED_ADAPTER_UNAVAILABLE',
        'This core has no adapter for the engine this installation needs.',
        adapterId
      )
    }
    if (contractVersion !== undefined && contractVersion !== adapter.contractVersion) {
      throw new AtomicCoreError(
        'MANAGED_ADAPTER_UNAVAILABLE',
        'The installation needs a different adapter contract version than this core implements.',
        `${adapterId}: wants ${contractVersion}, core implements ${adapter.contractVersion}`
      )
    }
    return adapter
  }
}
