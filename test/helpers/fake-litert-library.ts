/**
 * A `LiteRtLibrary` that behaves as the real one did in the spike (change `add-litert-lm-runtime`,
 * rulings S2): chunks are library message JSONs that arrive later on the JS thread, the last one
 * `final`; a cancel ends the stream with `CANCELLED: Task cancelled` and leaves the conversation
 * answering every later send the same way.
 */

import { LiteRtLibraryError } from '../../src/runtime/litert-lm/host/library.js'
import type {
  LiteRtBackendName,
  LiteRtChunk,
  LiteRtConversation,
  LiteRtConversationConfig,
  LiteRtEngine,
  LiteRtEngineSettings,
  LiteRtFileInfo,
  LiteRtLibrary,
  LiteRtMessage,
  LiteRtSendOptions,
} from '../../src/runtime/litert-lm/host/library.js'

/** One library chunk: a message object, or an error that ends the stream. */
export type FakeItem = Record<string, unknown> | { error: string }

export type FakeScript = (
  message: LiteRtMessage | LiteRtMessage[],
  options: LiteRtSendOptions,
  conversation: FakeConversation
) => FakeItem[]

export const text = (value: string) => ({ role: 'assistant', content: [{ type: 'text', text: value }] })

export const GEMMA_INFO: LiteRtFileInfo = {
  model_type: 'llm',
  max_context_tokens: 32003,
  dynamic_context: true,
  function_calling: false,
  thinking: false,
  modalities: ['text', 'vision', 'audio'],
  backends: ['cpu', 'gpu'],
  vision_backends: ['cpu'],
  npu: null,
  speculative_decoding: true,
  min_runtime_version: null,
}

export class FakeConversation implements LiteRtConversation {
  readonly sent: Array<{ message: LiteRtMessage | LiteRtMessage[]; options: LiteRtSendOptions }> = []
  closed = false
  poisoned = false
  private cancelRequested = false
  private tokens: number

  constructor(
    readonly config: LiteRtConversationConfig,
    private readonly library: FakeLiteRtLibrary
  ) {
    this.tokens = config.messages.length * 10
  }

  send(
    message: LiteRtMessage | LiteRtMessage[],
    options: LiteRtSendOptions,
    onChunk: (chunk: LiteRtChunk) => void
  ) {
    if (this.closed)
      throw new LiteRtLibraryError('conversation_send_message_stream', 'the conversation is closed')
    this.sent.push({ message, options })
    this.library.active++
    this.library.maxActive = Math.max(this.library.maxActive, this.library.active)
    this.tokens += Array.isArray(message) ? message.length * 10 : 10
    const items = this.poisoned ? [] : this.library.script(message, options, this)
    let at = 0
    const tick = () => {
      if (this.poisoned) {
        this.library.active--
        return onChunk({ text: null, error: 'CANCELLED: Task cancelled', final: true })
      }
      if (this.cancelRequested) {
        this.cancelRequested = false
        this.poisoned = true
        this.library.active--
        return onChunk({ text: null, error: 'CANCELLED: Task cancelled', final: true })
      }
      const item = items[at++]
      if (item === undefined) {
        this.library.active--
        return onChunk({ text: null, error: null, final: true })
      }
      if ('error' in item && typeof item.error === 'string') {
        this.library.active--
        return onChunk({ text: null, error: item.error, final: true })
      }
      this.tokens++
      onChunk({ text: JSON.stringify(item), error: null, final: false })
      setTimeout(tick, this.library.chunkDelayMs)
    }
    setTimeout(tick, this.library.chunkDelayMs)
  }

  cancel(): void {
    this.cancelRequested = true
  }

  tokenCount(): number {
    return this.tokens
  }

  close(): void {
    this.closed = true
  }
}

export class FakeEngine implements LiteRtEngine {
  readonly conversations: FakeConversation[] = []
  closed = false
  constructor(
    readonly settings: LiteRtEngineSettings,
    private readonly library: FakeLiteRtLibrary
  ) {}
  conversation(config: LiteRtConversationConfig): FakeConversation {
    const conversation = new FakeConversation(config, this.library)
    this.conversations.push(conversation)
    this.library.conversationsCreated++
    return conversation
  }
  close(): void {
    this.closed = true
  }
}

export class FakeLiteRtLibrary implements LiteRtLibrary {
  version: string | null = '0.18.1'
  abi = 1
  backends: LiteRtBackendName[] = ['cpu', 'gpu']
  readonly files = new Map<string, LiteRtFileInfo>()
  readonly engines: FakeEngine[] = []
  conversationsCreated = 0
  /** Generations under way right now, and the most at once. */
  active = 0
  maxActive = 0
  chunkDelayMs = 1
  failEngine: string | null = null
  script: FakeScript = () => [text('Hello'), text(' world')]

  inspect(file: string): LiteRtFileInfo {
    const info = this.files.get(file)
    if (!info) throw new LiteRtLibraryError('loaded_file_create', `${file} is not a LiteRT-LM file`)
    return info
  }

  createEngine(settings: LiteRtEngineSettings): FakeEngine {
    if (this.failEngine) throw new LiteRtLibraryError('engine_create', this.failEngine)
    const engine = new FakeEngine(settings, this)
    this.engines.push(engine)
    return engine
  }
}
