/**
 * `GeniexLibrary` over `bun:ffi` — the third file in `src/` that may import `bun:*` (change
 * `add-geniex-runtime`, design D1; allow-listed in both runtime-agnostic gates with `worker.ts`). It
 * is imported by the Worker alone, so the npm package still loads under Node.
 *
 * The binding follows `sdk/include/geniex.h` of GenieX v0.9.3 (ABI 1 of conf's manifest). Structs
 * are laid out by hand for a 64-bit little-endian target with natural alignment (Windows arm64 is
 * the only one); each layout names its offsets next to the C declaration it mirrors. The token
 * callback is a plain `JSCallback`: the library calls it synchronously on this very thread, from
 * inside `geniex_llm_generate`, which is why the whole binding lives in the Worker (design D1).
 *
 * Unverified against the real library until the spike on a Snapdragon X laptop (rulings/core.md).
 */

import { dlopen, FFIType, JSCallback, ptr, read, CString } from 'bun:ffi'
import type { NativeArgument, Pointer } from 'bun:ffi'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { BOUND_GENIEX_ABI, GENIEX_CANCELLED, GENIEX_POWER_MODES, GeniexLibraryError } from './library.js'
import type {
  GeniexChatMessage,
  GeniexGenerateResult,
  GeniexGenerationConfig,
  GeniexLibrary,
  GeniexModel,
  GeniexModelSettings,
  GeniexStopReason,
  GeniexTemplateInput,
  LoadGeniexLibrary,
} from './library.js'

const T = FFIType
const LIBRARY_FILE = 'geniex.dll'
/** The QAIRT runtime inside a build; told to the library so the `qairt` plugin finds it. */
const QAIRT_DIR = 'qairt'
const LOG_LEVEL_ERROR = 4
const STOP_REASONS: readonly GeniexStopReason[] = ['eos', 'length', 'user', 'stop_sequence', 'context_length']

const SYMBOLS = {
  geniex_get_error_message: { args: [T.i32], returns: T.cstring },
  geniex_init: { args: [], returns: T.i32 },
  geniex_deinit: { args: [], returns: T.i32 },
  geniex_set_log_level: { args: [T.i32], returns: T.i32 },
  geniex_set_qairt_runtime_path: { args: [T.ptr], returns: T.i32 },
  geniex_free: { args: [T.ptr], returns: T.void },
  geniex_version: { args: [], returns: T.cstring },
  geniex_get_plugin_list: { args: [T.ptr], returns: T.i32 },
  geniex_get_device_list: { args: [T.ptr, T.ptr], returns: T.i32 },
  geniex_resolve_device: { args: [T.ptr, T.ptr], returns: T.i32 },
  geniex_llm_create: { args: [T.ptr, T.ptr], returns: T.i32 },
  geniex_llm_destroy: { args: [T.ptr], returns: T.i32 },
  geniex_llm_apply_chat_template: { args: [T.ptr, T.ptr, T.ptr], returns: T.i32 },
  geniex_llm_generate: { args: [T.ptr, T.ptr, T.ptr], returns: T.i32 },
  geniex_vlm_create: { args: [T.ptr, T.ptr], returns: T.i32 },
  geniex_vlm_destroy: { args: [T.ptr], returns: T.i32 },
  geniex_vlm_apply_chat_template: { args: [T.ptr, T.ptr, T.ptr], returns: T.i32 },
  geniex_vlm_generate: { args: [T.ptr, T.ptr, T.ptr], returns: T.i32 },
} as const

type Fn = (...args: NativeArgument[]) => unknown
type L = Record<keyof typeof SYMBOLS, Fn>

const cstr = (value: string): Buffer => Buffer.from(`${value}\0`, 'utf8')
const wide = (value: string): Buffer => Buffer.from(`${value}\0`, 'utf16le')
const text = (value: unknown): string | null => {
  const s = value == null ? '' : String(value)
  return s === '' ? null : s
}

/** Keeps every buffer a struct points at alive for the length of one library call. */
class Arena {
  readonly kept: Buffer[] = []
  str(value: string | null): Pointer | null {
    if (value === null) return null
    const buffer = cstr(value)
    this.kept.push(buffer)
    return ptr(buffer)
  }
  /** A NUL-terminated array of C strings; `null` for an empty list. */
  strings(values: readonly string[]): Pointer | null {
    if (values.length === 0) return null
    const table = Buffer.alloc(8 * values.length)
    values.forEach((value, index) => table.writeBigUInt64LE(BigInt(this.str(value) ?? 0), index * 8))
    this.kept.push(table)
    return ptr(table)
  }
  struct(size: number): Buffer {
    const buffer = Buffer.alloc(size)
    this.kept.push(buffer)
    return buffer
  }
}

const writePtr = (buffer: Buffer, offset: number, value: Pointer | null) =>
  buffer.writeBigUInt64LE(BigInt(value ?? 0), offset)
const readPtr = (buffer: Buffer, offset: number): Pointer | null => {
  const value = buffer.readBigUInt64LE(offset)
  return value === 0n ? null : (Number(value) as Pointer)
}

/** Windows searches the library's own folder for its DLLs only when told to. */
function prepareWindowsSearch(libDir: string): void {
  const k32 = dlopen('kernel32.dll', { SetDllDirectoryW: { args: [T.ptr], returns: T.i32 } }).symbols
  k32.SetDllDirectoryW(ptr(wide(libDir)))
}

/**
 * Windows: out of EcoQoS, as `litert-lm/host/ffi-bun.ts` does. A process with no window counts as
 * background work and runs on efficiency cores at low clocks; a failure only costs speed.
 */
function leaveEcoQos(): void {
  const k32 = dlopen('kernel32.dll', {
    SetProcessInformation: { args: [T.i64, T.i32, T.ptr, T.u32], returns: T.i32 },
  }).symbols
  const PROCESS_POWER_THROTTLING = 4
  const state = new Uint32Array([1, 1, 0])
  k32.SetProcessInformation(-1n, PROCESS_POWER_THROTTLING, ptr(state), state.byteLength)
}

export const loadBunGeniexLibrary: LoadGeniexLibrary = async (libDir) => {
  const path = join(libDir, LIBRARY_FILE)
  if (!existsSync(path))
    throw new GeniexLibraryError('load', `${path} not found: no ${LIBRARY_FILE} in this build`)
  if (process.platform === 'win32') {
    prepareWindowsSearch(libDir)
    leaveEcoQos()
  }
  let L: L
  try {
    L = dlopen(path, SYMBOLS).symbols as L
  } catch (error) {
    throw new GeniexLibraryError('load', error instanceof Error ? error.message : String(error))
  }
  const check = (operation: string, code: unknown): void => {
    const value = Number(code)
    if (value === 0) return
    throw new GeniexLibraryError(
      operation,
      text(L.geniex_get_error_message(value)) ?? `error ${value}`,
      value
    )
  }
  const qairt = join(libDir, QAIRT_DIR)
  if (existsSync(qairt)) {
    const keep = cstr(qairt)
    check('set_qairt_runtime_path', L.geniex_set_qairt_runtime_path(ptr(keep)))
  }
  check('init', L.geniex_init())
  L.geniex_set_log_level(LOG_LEVEL_ERROR)
  return bindLibrary(L, check)
}

/** A `const char**` of `count` strings the library allocated; freed after reading. */
function takeStrings(L: L, table: Pointer | null, count: number): string[] {
  if (!table || count <= 0) return []
  const out: string[] = []
  for (let i = 0; i < count; i++) {
    const at = read.ptr(table, i * 8) as Pointer | 0
    out.push(at ? new CString(at as Pointer).toString() : '')
  }
  L.geniex_free(table)
  return out
}

function bindLibrary(L: L, check: (operation: string, code: unknown) => void): GeniexLibrary {
  const version = /^\d+\.\d+\.\d+/.exec(text(L.geniex_version()) ?? '')?.[0] ?? null

  function plugins(): string[] {
    // geniex_GetPluginListOutput { const char** plugin_ids @0; int32 plugin_count @8 } = 16
    const out = Buffer.alloc(16)
    check('get_plugin_list', L.geniex_get_plugin_list(ptr(out)))
    return takeStrings(L, readPtr(out, 0), out.readInt32LE(8))
  }

  function devices(plugin: string): string[] {
    const arena = new Arena()
    // geniex_GetDeviceListInput { const char* plugin_id @0 } = 8
    const input = arena.struct(8)
    writePtr(input, 0, arena.str(plugin))
    // geniex_GetDeviceListOutput { const char** device_ids @0; const char** device_names @8; int32 device_count @16 } = 24
    const out = arena.struct(24)
    check('get_device_list', L.geniex_get_device_list(ptr(input), ptr(out)))
    const count = out.readInt32LE(16)
    const ids = takeStrings(L, readPtr(out, 0), count)
    takeStrings(L, readPtr(out, 8), count)
    return ids
  }

  function resolveDevice(plugin: string, mode: string): { deviceId: string | null; ngl: number } {
    const arena = new Arena()
    // geniex_ResolveDeviceInput { plugin_id @0; model_name @8; mode @16; int32 ngl_default @24 } = 32
    const input = arena.struct(32)
    writePtr(input, 0, arena.str(plugin))
    writePtr(input, 8, null)
    writePtr(input, 16, arena.str(mode))
    input.writeInt32LE(999, 24)
    // geniex_ResolveDeviceOutput { char* device_id @0; int32 ngl @8; char* warning @16 } = 24
    const out = arena.struct(24)
    check('resolve_device', L.geniex_resolve_device(ptr(input), ptr(out)))
    const idPtr = readPtr(out, 0)
    const warningPtr = readPtr(out, 16)
    const deviceId = idPtr ? new CString(idPtr).toString() : null
    if (idPtr) L.geniex_free(idPtr)
    if (warningPtr) L.geniex_free(warningPtr)
    return { deviceId, ngl: out.readInt32LE(8) }
  }

  /** geniex_ModelConfig, 80 bytes, written into `buffer` at `at`. */
  function writeModelConfig(
    buffer: Buffer,
    at: number,
    arena: Arena,
    settings: GeniexModelSettings,
    ngl: number
  ): void {
    buffer.writeInt32LE(settings.nCtx, at + 0) // n_ctx
    buffer.writeInt32LE(0, at + 4) // n_threads: plugin default
    buffer.writeInt32LE(0, at + 8) // n_threads_batch
    buffer.writeInt32LE(0, at + 12) // n_batch
    buffer.writeInt32LE(0, at + 16) // n_ubatch
    buffer.writeInt32LE(0, at + 20) // n_seq_max
    buffer.writeInt32LE(ngl, at + 24) // n_gpu_layers, as resolve_device said
    writePtr(buffer, at + 32, null) // chat_template_path
    writePtr(buffer, at + 40, null) // chat_template_content
    writePtr(buffer, at + 48, arena.str('')) // spec_type: disabled
    writePtr(buffer, at + 56, arena.str('')) // spec_draft_model
    buffer.writeInt32LE(0, at + 64) // spec_n_max
    buffer.writeInt32LE(0, at + 68) // spec_n_min
    buffer.writeFloatLE(0, at + 72) // spec_p_min
    buffer.writeInt32LE(GENIEX_POWER_MODES.indexOf(settings.powerMode), at + 76) // power_mode
  }

  function createModel(settings: GeniexModelSettings): GeniexModel {
    const { deviceId, ngl } = resolveDevice(settings.plugin, settings.device)
    const vision = settings.mmproj !== null
    const arena = new Arena()
    const handleOut = arena.struct(8)
    if (vision) {
      // geniex_VlmCreateInput { model_path @0; mmproj_path @8; config @16 (80); plugin_id @96; device_id @104; vit_device_id @112; tokenizer_path @120 } = 128
      const input = arena.struct(128)
      writePtr(input, 0, arena.str(settings.model))
      writePtr(input, 8, arena.str(settings.mmproj))
      writeModelConfig(input, 16, arena, settings, ngl)
      writePtr(input, 96, arena.str(settings.plugin))
      writePtr(input, 104, arena.str(deviceId))
      writePtr(input, 112, null)
      writePtr(input, 120, null)
      check('vlm_create', L.geniex_vlm_create(ptr(input), ptr(handleOut)))
    } else {
      // geniex_LlmCreateInput { model_path @0; tokenizer_path @8; config @16 (80); plugin_id @96; device_id @104 } = 112
      const input = arena.struct(112)
      writePtr(input, 0, arena.str(settings.model))
      writePtr(input, 8, null)
      writeModelConfig(input, 16, arena, settings, ngl)
      writePtr(input, 96, arena.str(settings.plugin))
      writePtr(input, 104, arena.str(deviceId))
      check('llm_create', L.geniex_llm_create(ptr(input), ptr(handleOut)))
    }
    const handle = readPtr(handleOut, 0)
    if (!handle)
      throw new GeniexLibraryError(vision ? 'vlm_create' : 'llm_create', 'the library returned no handle')
    return bindModel(L, check, handle, vision)
  }

  return {
    version,
    abi: BOUND_GENIEX_ABI,
    plugins,
    devices,
    createModel,
    close: () => {
      L.geniex_deinit()
    },
  }
}

/** geniex_ToolCall[] { id @0; name @8; arguments @16 } = 24 each. */
function writeToolCalls(arena: Arena, calls: NonNullable<GeniexChatMessage['tool_calls']>): Pointer | null {
  if (calls.length === 0) return null
  const table = arena.struct(24 * calls.length)
  calls.forEach((call, index) => {
    writePtr(table, index * 24, arena.str(call.id))
    writePtr(table, index * 24 + 8, arena.str(call.name))
    writePtr(table, index * 24 + 16, arena.str(call.arguments))
  })
  return ptr(table)
}

function bindModel(
  L: L,
  check: (operation: string, code: unknown) => void,
  handle: Pointer,
  vision: boolean
): GeniexModel {
  function applyChatTemplate(input: GeniexTemplateInput): string {
    const arena = new Arena()
    const count = input.messages.length
    let messages: Buffer
    if (vision) {
      // geniex_VlmChatMessage { role @0; contents @8; int64 content_count @16; tool_calls @24; int32 tool_call_count @32; tool_call_id @40; tool_name @48 } = 56
      messages = arena.struct(56 * count)
      input.messages.forEach((message, index) => {
        const at = index * 56
        // geniex_VlmContent[] { type @0; text @8 } = 16 each
        const contents = arena.struct(16 * Math.max(1, message.content.length))
        message.content.forEach((part, j) => {
          writePtr(contents, j * 16, arena.str(part.type))
          writePtr(contents, j * 16 + 8, arena.str(part.type === 'text' ? part.text : part.path))
        })
        writePtr(messages, at, arena.str(message.role))
        writePtr(messages, at + 8, message.content.length > 0 ? ptr(contents) : null)
        messages.writeBigInt64LE(BigInt(message.content.length), at + 16)
        writePtr(messages, at + 24, writeToolCalls(arena, message.tool_calls ?? []))
        messages.writeInt32LE(message.tool_calls?.length ?? 0, at + 32)
        writePtr(messages, at + 40, arena.str(message.tool_call_id ?? null))
        writePtr(messages, at + 48, arena.str(message.tool_name ?? null))
      })
    } else {
      // geniex_LlmChatMessage { role @0; content @8; tool_calls @16; int32 tool_call_count @24; tool_call_id @32; tool_name @40 } = 48
      messages = arena.struct(48 * count)
      input.messages.forEach((message, index) => {
        const at = index * 48
        const content = message.content.map((part) => (part.type === 'text' ? part.text : '')).join('')
        writePtr(messages, at, arena.str(message.role))
        writePtr(messages, at + 8, arena.str(content))
        writePtr(messages, at + 16, writeToolCalls(arena, message.tool_calls ?? []))
        messages.writeInt32LE(message.tool_calls?.length ?? 0, at + 24)
        writePtr(messages, at + 32, arena.str(message.tool_call_id ?? null))
        writePtr(messages, at + 40, arena.str(message.tool_name ?? null))
      })
    }
    // Llm: { messages @0; int32 message_count @8; tools @16; bool enable_thinking @24; bool add_generation_prompt @25 } = 32
    // Vlm: { messages @0; int32 message_count @8; tools @16; bool enable_thinking @24; bool grounding @25 } = 32
    const request = arena.struct(32)
    writePtr(request, 0, count > 0 ? ptr(messages) : null)
    request.writeInt32LE(count, 8)
    writePtr(request, 16, arena.str(input.tools))
    request.writeUInt8(input.enableThinking ? 1 : 0, 24)
    request.writeUInt8(vision ? 0 : 1, 25)
    // Output { char* formatted_text @0 } = 8
    const out = arena.struct(8)
    check(
      vision ? 'vlm_apply_chat_template' : 'llm_apply_chat_template',
      vision
        ? L.geniex_vlm_apply_chat_template(handle, ptr(request), ptr(out))
        : L.geniex_llm_apply_chat_template(handle, ptr(request), ptr(out))
    )
    const formatted = readPtr(out, 0)
    if (!formatted) return ''
    const prompt = new CString(formatted).toString()
    L.geniex_free(formatted)
    return prompt
  }

  function generate(
    prompt: string,
    config: GeniexGenerationConfig,
    onToken: (token: string) => boolean
  ): GeniexGenerateResult {
    const arena = new Arena()
    // geniex_SamplerConfig { f32 temperature @0; f32 top_p @4; i32 top_k @8; f32 min_p @12; f32 repetition_penalty @16;
    //   f32 presence_penalty @20; f32 frequency_penalty @24; i32 seed @28; grammar_path @32; grammar_string @40; bool ignore_eos @48 } = 56
    const sampler = arena.struct(56)
    const s = config.sampler
    sampler.writeFloatLE(s.temperature ?? 0.8, 0)
    sampler.writeFloatLE(s.topP ?? 0.95, 4)
    sampler.writeInt32LE(s.topK ?? 40, 8)
    sampler.writeFloatLE(0.05, 12)
    sampler.writeFloatLE(1.0, 16)
    sampler.writeFloatLE(0, 20)
    sampler.writeFloatLE(0, 24)
    sampler.writeInt32LE(s.seed ?? -1, 28)
    writePtr(sampler, 32, null)
    writePtr(sampler, 40, arena.str(s.grammar))
    sampler.writeUInt8(0, 48)
    // geniex_GenerationConfig { i32 max_tokens @0; stop @8; i32 stop_count @16; sampler_config @24; image_paths @32;
    //   i32 image_count @40; audio_paths @48; i32 audio_count @56; bool sliding_window @60; i32 sliding_window_n_keep @64 } = 72
    const generation = arena.struct(72)
    generation.writeInt32LE(config.maxTokens, 0)
    writePtr(generation, 8, arena.strings(config.stop))
    generation.writeInt32LE(config.stop.length, 16)
    writePtr(generation, 24, ptr(sampler))
    writePtr(generation, 32, arena.strings(config.imagePaths))
    generation.writeInt32LE(config.imagePaths.length, 40)
    writePtr(generation, 48, null)
    generation.writeInt32LE(0, 56)
    generation.writeUInt8(0, 60)
    generation.writeInt32LE(0, 64)
    let callbackError: unknown = null
    const callback = new JSCallback(
      (tokenPtr: Pointer | 0) => {
        try {
          return onToken(tokenPtr ? new CString(tokenPtr).toString() : '')
        } catch (error) {
          callbackError = error
          return false
        }
      },
      { args: [T.ptr, T.ptr], returns: T.bool }
    )
    try {
      // Llm: { prompt_utf8 @0; config @8; on_token @16; user_data @24; input_ids @32; i32 input_ids_count @40; input_embd @48; i32 count @56; i32 dim @60 } = 64
      // Vlm: { prompt_utf8 @0; config @8; on_token @16; user_data @24 } = 32 (the Llm layout is a superset, zero beyond)
      const input = arena.struct(64)
      writePtr(input, 0, arena.str(prompt))
      writePtr(input, 8, ptr(generation))
      writePtr(input, 16, callback.ptr)
      writePtr(input, 24, null)
      // Output { char* full_text @0; geniex_ProfileData @8: i64 ttft @8, media_time @16, prompt_time @24, decode_time @32,
      //   prompt_tokens @40, generated_tokens @48, f64 prefill_speed @56, decoding_speed @64, i64 draft_n_total @72, draft_n_accepted @80, stop_reason @88 } = 96
      const out = arena.struct(96)
      const code = Number(
        vision
          ? L.geniex_vlm_generate(handle, ptr(input), ptr(out))
          : L.geniex_llm_generate(handle, ptr(input), ptr(out))
      )
      if (callbackError) throw callbackError
      if (code === GENIEX_CANCELLED)
        throw new GeniexLibraryError(
          vision ? 'vlm_generate' : 'llm_generate',
          'Operation cancelled by caller',
          code
        )
      check(vision ? 'vlm_generate' : 'llm_generate', code)
      const fullText = readPtr(out, 0)
      if (fullText) L.geniex_free(fullText)
      const stopPtr = readPtr(out, 88)
      const stop = stopPtr ? new CString(stopPtr).toString() : ''
      return {
        stopReason: STOP_REASONS.find((reason) => reason === stop) ?? 'unknown',
        promptTokens: Number(out.readBigInt64LE(40)),
        generatedTokens: Number(out.readBigInt64LE(48)),
      }
    } finally {
      callback.close()
    }
  }

  return {
    vision,
    applyChatTemplate,
    generate,
    destroy: () => {
      if (vision) L.geniex_vlm_destroy(handle)
      else L.geniex_llm_destroy(handle)
    },
  }
}
