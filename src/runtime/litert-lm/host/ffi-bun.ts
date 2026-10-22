/**
 * `LiteRtLibrary` over `bun:ffi` — the second and last file in `src/` that may import `bun:*` (change
 * `add-litert-lm-runtime`, design D1 and decision 3.6; allow-listed in both runtime-agnostic gates). It
 * is imported dynamically by the `litert-host` mode alone, so the npm package still loads under Node.
 *
 * Streaming is the hard part (spike S2). The library calls a stream callback on a C++ thread of its
 * own and frees the chunk as soon as the callback returns. A plain `JSCallback` cannot run there; a
 * `threadsafe` one only queues the call, so the JS thread would read freed memory, and even with the
 * chunk copied first Bun's threadsafe callbacks crashed about one run in five under a fast stream.
 * So the callback is C: a shim compiled at start by the TinyCC built into Bun (`cc`) copies each chunk
 * on the library's thread into a FIFO under a mutex, and JS drains the FIFO on a 2 ms timer that runs
 * only while a generation is under way. The shim links nothing (`-nostdlib`: TinyCC finds no libc
 * without development packages on Linux); `malloc` and the mutex come in as pointers from `dlsym`.
 */

import { cc, CString, dlopen, FFIType, ptr, read } from 'bun:ffi'
import type { NativeArgument, Pointer } from 'bun:ffi'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BOUND_LITERT_LM_ABI, LiteRtLibraryError, samplerSettings } from './library.js'
import type {
  LiteRtBackendName,
  LiteRtChunk,
  LiteRtConversation,
  LiteRtConversationConfig,
  LiteRtEngine,
  LiteRtEngineSettings,
  LiteRtFileInfo,
  LiteRtLibrary,
  LiteRtModality,
  LiteRtNpuBrand,
  LoadLiteRtLibrary,
} from './library.js'

const T = FFIType
const LIBRARY_FILE: Partial<Record<NodeJS.Platform, string>> = {
  darwin: 'liblitert-lm.dylib',
  linux: 'liblitert-lm.so',
  win32: 'litert-lm.dll',
}
/** Intel's NPU dispatch library inside a Windows build (`vendors/intel_openvino/dispatch`). */
const NPU_DISPATCH = join('vendors', 'intel_openvino', 'dispatch')
const SAMPLER_TOP_P = 2
const CONSTRAINT = { regex: 1, json_schema: 2 } as const
const CONSTRAINT_PROVIDER_LL_GUIDANCE = 1
const BACKENDS: Record<number, LiteRtBackendName> = { 1: 'cpu', 2: 'gpu', 3: 'npu' }
const MODALITIES: LiteRtModality[] = ['text', 'vision', 'audio', 'video']
const NPU_BRANDS: LiteRtNpuBrand[] = ['unknown', 'qualcomm', 'google-tensor', 'mediatek', 'intel', 'samsung']
const MODEL_TYPES = ['unknown', 'llm', 'embedding'] as const
/** `litert::lm::LITERT_LM_VERSION`, a `std::string_view` (pointer, length) — the library has no C getter. */
const VERSION_SYMBOL = '_ZN6litert2lm17LITERT_LM_VERSIONE'
const DRAIN_INTERVAL_MS = 2

const SYMBOLS = {
  litert_lm_set_min_log_level: { args: [T.i32], returns: T.void },
  litert_lm_get_last_error_message: { args: [], returns: T.cstring },
  litert_lm_loaded_file_create: { args: [T.ptr], returns: T.ptr },
  litert_lm_loaded_file_delete: { args: [T.ptr], returns: T.void },
  litert_lm_loaded_file_has_speculative_decoding_support: { args: [T.ptr], returns: T.bool },
  litert_lm_loaded_file_supports_thinking: { args: [T.ptr], returns: T.bool },
  litert_lm_loaded_file_supports_function_calling: { args: [T.ptr], returns: T.bool },
  litert_lm_loaded_file_supports_input_modality: { args: [T.ptr, T.i32], returns: T.bool },
  litert_lm_loaded_file_max_context_tokens: { args: [T.ptr], returns: T.u32 },
  litert_lm_loaded_file_is_dynamic_context: { args: [T.ptr], returns: T.bool },
  litert_lm_loaded_file_min_runtime_version: { args: [T.ptr], returns: T.cstring },
  litert_lm_loaded_file_modality_supported_backends: { args: [T.ptr, T.i32, T.ptr, T.i32], returns: T.i32 },
  litert_lm_loaded_file_model_type: { args: [T.ptr], returns: T.i32 },
  litert_lm_loaded_file_modality_npu_brand: { args: [T.ptr, T.i32], returns: T.i32 },
  litert_lm_loaded_file_modality_soc_name: { args: [T.ptr, T.i32], returns: T.cstring },
  litert_lm_engine_settings_create: { args: [T.ptr, T.ptr, T.ptr, T.ptr], returns: T.ptr },
  litert_lm_engine_settings_delete: { args: [T.ptr], returns: T.void },
  litert_lm_engine_settings_set_max_num_tokens: { args: [T.ptr, T.i32], returns: T.void },
  litert_lm_engine_settings_set_max_num_images: { args: [T.ptr, T.i32], returns: T.void },
  litert_lm_engine_settings_set_cache_dir: { args: [T.ptr, T.ptr], returns: T.void },
  litert_lm_engine_settings_set_litert_dispatch_lib_dir: { args: [T.ptr, T.ptr], returns: T.void },
  litert_lm_engine_settings_set_enable_speculative_decoding: { args: [T.ptr, T.bool], returns: T.void },
  litert_lm_engine_create: { args: [T.ptr], returns: T.ptr },
  litert_lm_engine_delete: { args: [T.ptr], returns: T.void },
  litert_lm_session_config_create: { args: [], returns: T.ptr },
  litert_lm_session_config_delete: { args: [T.ptr], returns: T.void },
  litert_lm_session_config_set_sampler_params: { args: [T.ptr, T.ptr], returns: T.void },
  litert_lm_sampler_params_create: { args: [T.i32], returns: T.ptr },
  litert_lm_sampler_params_delete: { args: [T.ptr], returns: T.void },
  litert_lm_sampler_params_set_top_k: { args: [T.ptr, T.i32], returns: T.void },
  litert_lm_sampler_params_set_top_p: { args: [T.ptr, T.f32], returns: T.void },
  litert_lm_sampler_params_set_temperature: { args: [T.ptr, T.f32], returns: T.void },
  litert_lm_sampler_params_set_seed: { args: [T.ptr, T.i32], returns: T.void },
  litert_lm_conversation_config_create: { args: [], returns: T.ptr },
  litert_lm_conversation_config_delete: { args: [T.ptr], returns: T.void },
  litert_lm_conversation_config_set_session_config: { args: [T.ptr, T.ptr], returns: T.void },
  litert_lm_conversation_config_set_tools: { args: [T.ptr, T.ptr], returns: T.void },
  litert_lm_conversation_config_set_messages: { args: [T.ptr, T.ptr], returns: T.void },
  litert_lm_conversation_config_set_enable_constrained_decoding: { args: [T.ptr, T.bool], returns: T.void },
  litert_lm_conversation_config_set_constraint_provider: { args: [T.ptr, T.ptr], returns: T.void },
  litert_lm_thinking_config_create: { args: [], returns: T.ptr },
  litert_lm_thinking_config_delete: { args: [T.ptr], returns: T.void },
  litert_lm_thinking_config_set_enable_thinking: { args: [T.ptr, T.bool], returns: T.void },
  litert_lm_conversation_optional_args_create: { args: [], returns: T.ptr },
  litert_lm_conversation_optional_args_delete: { args: [T.ptr], returns: T.void },
  litert_lm_conversation_optional_args_set_constraint: { args: [T.ptr, T.i32, T.ptr], returns: T.void },
  litert_lm_conversation_optional_args_set_max_output_tokens: { args: [T.ptr, T.i32], returns: T.void },
  litert_lm_conversation_optional_args_set_thinking_config: { args: [T.ptr, T.ptr], returns: T.void },
  litert_lm_conversation_create: { args: [T.ptr, T.ptr], returns: T.ptr },
  litert_lm_conversation_delete: { args: [T.ptr], returns: T.void },
  litert_lm_conversation_send_message_stream: {
    args: [T.ptr, T.ptr, T.ptr, T.ptr, T.ptr, T.ptr],
    returns: T.i32,
  },
  litert_lm_conversation_cancel_process: { args: [T.ptr], returns: T.void },
  litert_lm_conversation_get_token_count: { args: [T.ptr], returns: T.i32 },
  litert_lm_stream_chunk_get_text: { args: [T.ptr], returns: T.cstring },
  litert_lm_stream_chunk_is_final: { args: [T.ptr], returns: T.bool },
  litert_lm_stream_chunk_get_error: { args: [T.ptr], returns: T.cstring },
} as const

/** The chunk shim: compiled at start, no libc linked, everything it calls comes in as a pointer. */
const SHIM_C = `typedef unsigned long long size_t;
typedef void *(*calloc_fn)(size_t, size_t);
typedef void (*free_fn)(void *);
typedef size_t (*strlen_fn)(const char *);
typedef void *(*memcpy_fn)(void *, const void *, size_t);
typedef void (*lock_fn)(void *);
typedef const char *(*get_str_fn)(void *);
typedef _Bool (*get_bool_fn)(void *);
static calloc_fn m_calloc;
static free_fn m_free;
static strlen_fn m_strlen;
static memcpy_fn m_memcpy;
static lock_fn m_lock, m_unlock;
static void *g_mutex;
static get_str_fn g_text, g_err;
static get_bool_fn g_final;
struct copy { char *text; char *err; int final; void *data; struct copy *next; };
static struct copy *q_head, *q_tail;
static char *dup(const char *s) {
  if (!s) return 0;
  size_t n = m_strlen(s);
  char *d = m_calloc(n + 1, 1);
  m_memcpy(d, s, n + 1);
  return d;
}
void shim_init(void *c, void *f, void *l, void *m, void *lock, void *unlock, void *mutex,
               void *text, void *err, void *fin) {
  m_calloc = (calloc_fn)c; m_free = (free_fn)f; m_strlen = (strlen_fn)l; m_memcpy = (memcpy_fn)m;
  m_lock = (lock_fn)lock; m_unlock = (lock_fn)unlock; g_mutex = mutex;
  g_text = (get_str_fn)text; g_err = (get_str_fn)err; g_final = (get_bool_fn)fin;
}
/* The library's thread: copy the chunk before it is freed, append the copy to the FIFO. */
void shim_on_chunk(void *data, void *chunk) {
  struct copy *c = m_calloc(1, sizeof *c);
  c->text = dup(g_text(chunk));
  c->err = dup(g_err(chunk));
  c->final = g_final(chunk);
  c->data = data;
  m_lock(g_mutex);
  if (q_tail) q_tail->next = c; else q_head = c;
  q_tail = c;
  m_unlock(g_mutex);
}
void *shim_on_chunk_ptr(void) { return (void *)shim_on_chunk; }
struct copy *shim_pop(void) {
  m_lock(g_mutex);
  struct copy *c = q_head;
  if (c) { q_head = c->next; if (!q_head) q_tail = 0; }
  m_unlock(g_mutex);
  return c;
}
void *shim_data(struct copy *c) { return c->data; }
const char *shim_text(struct copy *c) { return c->text; }
const char *shim_err(struct copy *c) { return c->err; }
int shim_final(struct copy *c) { return c->final; }
void shim_free(struct copy *c) { m_free(c->text); m_free(c->err); m_free(c); }
`

type Fn = (...args: NativeArgument[]) => unknown
const cstr = (value: string): Buffer => Buffer.from(`${value}\0`, 'utf8')
const wide = (value: string): Buffer => Buffer.from(`${value}\0`, 'utf16le')
const text = (value: unknown): string | null => {
  const s = value == null ? '' : String(value)
  return s === '' ? null : s
}

/** Where a symbol of a loaded library lives: `dlsym` (POSIX) or `GetProcAddress` (Windows). */
interface SymbolLookup {
  open(path: string): Pointer
  find(handle: Pointer, name: string): Pointer | null
}

function symbolLookup(): SymbolLookup {
  if (process.platform === 'win32') {
    const k32 = dlopen('kernel32.dll', {
      LoadLibraryW: { args: [T.ptr], returns: T.ptr },
      GetProcAddress: { args: [T.ptr, T.ptr], returns: T.ptr },
    }).symbols
    return {
      open: (path) => k32.LoadLibraryW(ptr(wide(path))) as Pointer,
      find: (handle, name) => (k32.GetProcAddress(handle, ptr(cstr(name))) as Pointer | null) || null,
    }
  }
  const libc = dlopen(process.platform === 'darwin' ? 'libSystem.B.dylib' : 'libc.so.6', {
    dlopen: { args: [T.ptr, T.i32], returns: T.ptr },
    dlsym: { args: [T.ptr, T.ptr], returns: T.ptr },
  }).symbols
  const RTLD_NOW = 2
  return {
    open: (path) => libc.dlopen(ptr(cstr(path)), RTLD_NOW) as Pointer,
    find: (handle, name) => (libc.dlsym(handle, ptr(cstr(name))) as Pointer | null) || null,
  }
}

/**
 * The C runtime and a mutex for the shim; on Windows an SRW lock, which needs no init call. `memory`
 * holds the mutex: the shim keeps its address, so it must live as long as the shim does.
 */
function shimRuntime(lookup: SymbolLookup): { pointers: Pointer[]; mutex: Pointer; memory: BigUint64Array } {
  const need = (handle: Pointer, name: string): Pointer => {
    const at = lookup.find(handle, name)
    if (!at) throw new LiteRtLibraryError('load', `the system has no ${name}`)
    return at
  }
  if (process.platform === 'win32') {
    const crt = lookup.open('ucrtbase.dll')
    const k32 = lookup.open('kernel32.dll')
    const memory = new BigUint64Array(1) // SRWLOCK_INIT is a zeroed pointer
    return {
      pointers: [
        ...['calloc', 'free', 'strlen', 'memcpy'].map((name) => need(crt, name)),
        need(k32, 'AcquireSRWLockExclusive'),
        need(k32, 'ReleaseSRWLockExclusive'),
      ],
      mutex: ptr(memory),
      memory,
    }
  }
  const libc = lookup.open(process.platform === 'darwin' ? 'libSystem.B.dylib' : 'libc.so.6')
  const memory = new BigUint64Array(16) // pthread_mutex_t: 64 bytes on macOS, 40 on Linux
  const mutex = ptr(memory)
  const init = dlopen(process.platform === 'darwin' ? 'libSystem.B.dylib' : 'libc.so.6', {
    pthread_mutex_init: { args: [T.ptr, T.ptr], returns: T.i32 },
  }).symbols
  init.pthread_mutex_init(mutex, null)
  return {
    pointers: [
      ...['calloc', 'free', 'strlen', 'memcpy'].map((name) => need(libc, name)),
      need(libc, 'pthread_mutex_lock'),
      need(libc, 'pthread_mutex_unlock'),
    ],
    mutex,
    memory,
  }
}

/** Windows: the library's own folder, and for the NPU OpenVINO's, must be searched for its DLLs. */
function prepareWindowsSearch(libDir: string, ovLibsDir: string | undefined): void {
  const k32 = dlopen('kernel32.dll', {
    SetDllDirectoryW: { args: [T.ptr], returns: T.i32 },
    SetEnvironmentVariableW: { args: [T.ptr, T.ptr], returns: T.i32 },
  }).symbols
  k32.SetDllDirectoryW(ptr(wide(libDir)))
  // The Python binding puts OpenVINO's `libs` on PATH; the dispatch library loads them from there.
  if (ovLibsDir)
    k32.SetEnvironmentVariableW(ptr(wide('PATH')), ptr(wide(`${ovLibsDir};${process.env['PATH'] ?? ''}`)))
}

/**
 * Windows: out of EcoQoS. A process with no window counts as background work, and Windows runs it on
 * efficiency cores at low clocks; on an i7-14700HX that held CPU decode of Gemma 4 E2B at 9 tok/s
 * against 29 without it (`ProcessPowerThrottling`, execution speed off). A failure only costs speed.
 */
function leaveEcoQos(): void {
  const k32 = dlopen('kernel32.dll', {
    SetProcessInformation: { args: [T.i64, T.i32, T.ptr, T.u32], returns: T.i32 },
  }).symbols
  const PROCESS_POWER_THROTTLING = 4
  // Version 1, control execution speed, state off.
  const state = new Uint32Array([1, 1, 0])
  k32.SetProcessInformation(-1n, PROCESS_POWER_THROTTLING, ptr(state), state.byteLength)
}

function readVersion(lookup: SymbolLookup, handle: Pointer): string | null {
  const at = lookup.find(handle, VERSION_SYMBOL)
  if (!at) return null
  const length = read.u32(at, 8)
  const start = read.ptr(at, 0)
  if (!start || length <= 0 || length > 64) return null
  const bytes = Buffer.alloc(length)
  for (let i = 0; i < length; i++) bytes[i] = read.u8(start, i)
  const version = bytes.toString('utf8')
  return /^\d+\.\d+\.\d+$/.test(version) ? version : null
}

export const loadBunLiteRtLibrary: LoadLiteRtLibrary = async (libDir, options = {}) => {
  const file = LIBRARY_FILE[process.platform]
  if (!file) throw new LiteRtLibraryError('load', `LiteRT-LM has no library for ${process.platform}`)
  const path = join(libDir, file)
  if (!existsSync(path)) throw new LiteRtLibraryError('load', `${path} not found: no ${file} in this build`)
  if (process.platform === 'win32') {
    prepareWindowsSearch(libDir, options.ovLibsDir)
    leaveEcoQos()
  }
  let L: Record<keyof typeof SYMBOLS, Fn>
  try {
    L = dlopen(path, SYMBOLS).symbols as Record<keyof typeof SYMBOLS, Fn>
  } catch (error) {
    throw new LiteRtLibraryError('load', error instanceof Error ? error.message : String(error))
  }
  const lookup = symbolLookup()
  const handle = lookup.open(path)
  // ERROR: the library's INFO/WARNING lines would flood the host's stderr, which core keeps a tail of.
  L.litert_lm_set_min_log_level(4)
  const chunkSymbols = [
    'litert_lm_stream_chunk_get_text',
    'litert_lm_stream_chunk_get_error',
    'litert_lm_stream_chunk_is_final',
  ]
  const chunkPointers = chunkSymbols.map((name) => {
    const at = lookup.find(handle, name)
    if (!at) throw new LiteRtLibraryError('load', `${file} does not export ${name}`)
    return at
  })
  const backends: LiteRtBackendName[] = existsSync(join(libDir, NPU_DISPATCH))
    ? ['cpu', 'gpu', 'npu']
    : ['cpu', 'gpu']
  return bindLibrary(L, {
    version: readVersion(lookup, handle),
    backends,
    lookup,
    chunkPointers,
  })
}

interface BindContext {
  version: string | null
  backends: LiteRtBackendName[]
  lookup: SymbolLookup
  chunkPointers: Pointer[]
}

function bindLibrary(L: Record<keyof typeof SYMBOLS, Fn>, context: BindContext): LiteRtLibrary {
  const lastError = (): string => text(L.litert_lm_get_last_error_message()) ?? 'the library gave no reason'
  const shim = compileShim(context)

  function inspect(file: string): LiteRtFileInfo {
    const loaded = L.litert_lm_loaded_file_create(ptr(cstr(file))) as Pointer | null
    if (!loaded) throw new LiteRtLibraryError('loaded_file_create', lastError())
    try {
      const backendsOf = (modality: number): LiteRtBackendName[] => {
        const count = Number(L.litert_lm_loaded_file_modality_supported_backends(loaded, modality, null, 0))
        if (count <= 0) return []
        const out = new Int32Array(count)
        L.litert_lm_loaded_file_modality_supported_backends(loaded, modality, ptr(out), count)
        return [...out].flatMap((id) => (BACKENDS[id] ? [BACKENDS[id]] : []))
      }
      const modalities = MODALITIES.filter(
        (_, index) => L.litert_lm_loaded_file_supports_input_modality(loaded, index) === true
      )
      const brand = Number(L.litert_lm_loaded_file_modality_npu_brand(loaded, 0))
      const max = Number(L.litert_lm_loaded_file_max_context_tokens(loaded))
      const backends = backendsOf(0)
      return {
        model_type: MODEL_TYPES[Number(L.litert_lm_loaded_file_model_type(loaded))] ?? 'unknown',
        max_context_tokens: max > 0 ? max : null,
        dynamic_context: L.litert_lm_loaded_file_is_dynamic_context(loaded) === true,
        function_calling: L.litert_lm_loaded_file_supports_function_calling(loaded) === true,
        thinking: L.litert_lm_loaded_file_supports_thinking(loaded) === true,
        modalities,
        backends,
        vision_backends: modalities.includes('vision') ? backendsOf(1) : [],
        npu: backends.includes('npu')
          ? {
              brand: NPU_BRANDS[brand] ?? 'unknown',
              soc: text(L.litert_lm_loaded_file_modality_soc_name(loaded, 0)),
            }
          : null,
        speculative_decoding: L.litert_lm_loaded_file_has_speculative_decoding_support(loaded) === true,
        min_runtime_version: text(L.litert_lm_loaded_file_min_runtime_version(loaded)),
      }
    } finally {
      L.litert_lm_loaded_file_delete(loaded)
    }
  }

  function createEngine(settings: LiteRtEngineSettings): LiteRtEngine {
    const config = L.litert_lm_engine_settings_create(
      ptr(cstr(settings.model)),
      ptr(cstr(settings.backend)),
      settings.visionBackend ? ptr(cstr(settings.visionBackend)) : null,
      null
    ) as Pointer | null
    if (!config) throw new LiteRtLibraryError('engine_settings_create', lastError())
    let engine: Pointer | null
    try {
      L.litert_lm_engine_settings_set_max_num_tokens(config, settings.maxNumTokens)
      if (settings.visionBackend) L.litert_lm_engine_settings_set_max_num_images(config, 1)
      L.litert_lm_engine_settings_set_cache_dir(config, ptr(cstr(settings.cacheDir)))
      if (settings.dispatchLibDir)
        L.litert_lm_engine_settings_set_litert_dispatch_lib_dir(config, ptr(cstr(settings.dispatchLibDir)))
      L.litert_lm_engine_settings_set_enable_speculative_decoding(config, settings.speculative)
      engine = L.litert_lm_engine_create(config) as Pointer | null
    } finally {
      L.litert_lm_engine_settings_delete(config)
    }
    if (!engine) throw new LiteRtLibraryError('engine_create', lastError())
    const handle = engine
    return {
      conversation: (conversationConfig) => createConversation(handle, conversationConfig),
      close: () => {
        L.litert_lm_engine_delete(handle)
      },
    }
  }

  function createConversation(engine: Pointer, config: LiteRtConversationConfig): LiteRtConversation {
    const session = L.litert_lm_session_config_create() as Pointer
    const settings = samplerSettings(config.sampler)
    if (settings) {
      const sampler = L.litert_lm_sampler_params_create(SAMPLER_TOP_P) as Pointer
      L.litert_lm_sampler_params_set_top_k(sampler, settings.topK)
      L.litert_lm_sampler_params_set_top_p(sampler, settings.topP)
      L.litert_lm_sampler_params_set_temperature(sampler, settings.temperature)
      L.litert_lm_sampler_params_set_seed(sampler, settings.seed)
      L.litert_lm_session_config_set_sampler_params(session, sampler)
      L.litert_lm_sampler_params_delete(sampler)
    }
    const conversationConfig = L.litert_lm_conversation_config_create() as Pointer
    let conversation: Pointer | null
    try {
      L.litert_lm_conversation_config_set_session_config(conversationConfig, session)
      if (config.messages.length > 0)
        L.litert_lm_conversation_config_set_messages(
          conversationConfig,
          ptr(cstr(JSON.stringify(config.messages)))
        )
      if (config.tools && config.tools.length > 0)
        L.litert_lm_conversation_config_set_tools(conversationConfig, ptr(cstr(JSON.stringify(config.tools))))
      if (config.constrained) {
        L.litert_lm_conversation_config_set_enable_constrained_decoding(conversationConfig, true)
        L.litert_lm_conversation_config_set_constraint_provider(
          conversationConfig,
          ptr(new Int32Array([CONSTRAINT_PROVIDER_LL_GUIDANCE]))
        )
      }
      conversation = L.litert_lm_conversation_create(engine, conversationConfig) as Pointer | null
    } finally {
      L.litert_lm_session_config_delete(session)
      L.litert_lm_conversation_config_delete(conversationConfig)
    }
    if (!conversation) throw new LiteRtLibraryError('conversation_create', lastError())
    const handle = conversation
    return {
      send(message, options, onChunk) {
        let args: Pointer | null = null
        let thinking: Pointer | null = null
        if (options.constraint || options.maxOutputTokens !== undefined || options.thinking !== undefined) {
          args = L.litert_lm_conversation_optional_args_create() as Pointer
          if (options.constraint)
            L.litert_lm_conversation_optional_args_set_constraint(
              args,
              CONSTRAINT[options.constraint.kind],
              ptr(cstr(options.constraint.value))
            )
          if (options.maxOutputTokens !== undefined)
            L.litert_lm_conversation_optional_args_set_max_output_tokens(args, options.maxOutputTokens)
          if (options.thinking !== undefined) {
            thinking = L.litert_lm_thinking_config_create() as Pointer
            L.litert_lm_thinking_config_set_enable_thinking(thinking, options.thinking)
            L.litert_lm_conversation_optional_args_set_thinking_config(args, thinking)
          }
        }
        const messageBuffer = cstr(JSON.stringify(message))
        const contextBuffer = cstr('{}')
        const id = shim.register(onChunk)
        try {
          const rc = Number(
            L.litert_lm_conversation_send_message_stream(
              handle,
              ptr(messageBuffer),
              ptr(contextBuffer),
              args,
              shim.onChunk,
              id
            )
          )
          if (rc !== 0) {
            shim.unregister(id)
            throw new LiteRtLibraryError('conversation_send_message_stream', lastError())
          }
        } finally {
          if (thinking) L.litert_lm_thinking_config_delete(thinking)
          if (args) L.litert_lm_conversation_optional_args_delete(args)
        }
      },
      cancel: () => {
        L.litert_lm_conversation_cancel_process(handle)
      },
      tokenCount: () => Number(L.litert_lm_conversation_get_token_count(handle)),
      close: () => {
        L.litert_lm_conversation_delete(handle)
      },
    }
  }

  return {
    version: context.version,
    abi: BOUND_LITERT_LM_ABI,
    backends: context.backends,
    inspect,
    createEngine,
  }
}

/** What native code holds addresses into, for the life of the process. */
const retained: unknown[] = []

interface ChunkShim {
  /** The C callback to hand the library. */
  onChunk: Pointer
  /** A stream id for `user_data`; its handler runs on the JS thread for each chunk, in order. */
  register(handler: (chunk: LiteRtChunk) => void): number
  unregister(id: number): void
}

function compileShim(context: BindContext): ChunkShim {
  const dir = mkdtempSync(join(tmpdir(), 'atomic-litert-shim-'))
  const source = join(dir, 'shim.c')
  let S: Record<string, Fn>
  try {
    writeFileSync(source, SHIM_C)
    S = cc({
      source,
      flags: ['-nostdlib'],
      symbols: {
        shim_init: { args: Array(10).fill(T.ptr), returns: T.void },
        shim_on_chunk_ptr: { args: [], returns: T.ptr },
        shim_pop: { args: [], returns: T.ptr },
        shim_data: { args: [T.ptr], returns: T.ptr },
        shim_text: { args: [T.ptr], returns: T.ptr },
        shim_err: { args: [T.ptr], returns: T.ptr },
        shim_final: { args: [T.ptr], returns: T.i32 },
        shim_free: { args: [T.ptr], returns: T.void },
      },
    }).symbols as Record<string, Fn>
  } catch (error) {
    throw new LiteRtLibraryError(
      'compile the stream shim',
      error instanceof Error ? error.message : String(error)
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  const runtime = shimRuntime(context.lookup)
  retained.push(runtime.memory)
  S['shim_init']?.(...runtime.pointers.slice(0, 6), runtime.mutex, ...context.chunkPointers)
  const handlers = new Map<number, (chunk: LiteRtChunk) => void>()
  let next = 1
  let timer: ReturnType<typeof setInterval> | null = null
  const str = (at: unknown): string | null => (at ? new CString(at as Pointer).toString() : null)
  const drain = () => {
    for (let copy = S['shim_pop']?.() as Pointer | null; copy; copy = S['shim_pop']?.() as Pointer | null) {
      const id = Number(S['shim_data']?.(copy))
      const chunk: LiteRtChunk = {
        text: str(S['shim_text']?.(copy)),
        error: str(S['shim_err']?.(copy)),
        final: S['shim_final']?.(copy) !== 0,
      }
      S['shim_free']?.(copy)
      const handler = handlers.get(id)
      if (chunk.final || chunk.error) handlers.delete(id)
      handler?.(chunk)
    }
    if (handlers.size === 0 && timer) {
      clearInterval(timer)
      timer = null
    }
  }
  return {
    onChunk: S['shim_on_chunk_ptr']?.() as Pointer,
    register(handler) {
      const id = next++
      handlers.set(id, handler)
      timer ??= setInterval(drain, DRAIN_INTERVAL_MS)
      return id
    },
    unregister(id) {
      handlers.delete(id)
    },
  }
}
