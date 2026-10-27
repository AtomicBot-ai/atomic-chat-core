/**
 * The host's own OpenAI server (openspec change `add-geniex-runtime`, design D6, tasks 5.4–5.5):
 * `GET /v1/models` and `POST /v1/chat/completions` on `127.0.0.1:<port>`, with no authentication —
 * core's session gateway is the only door in, and it checks the key. Generations run one at a time
 * in arrival order (`FifoLock`): the library is single-threaded, and the Worker that owns it blocks
 * for a whole generation. `/v1/models` never waits on the queue.
 *
 * Every request is a full prompt: the chat template is applied in the Worker, the tokens stream back
 * through it, and the reply parser turns them into deltas. A client that hangs up sets the shared
 * cancel flag the Worker's token callback reads; a stop string does the same. Images come as data
 * URLs and go to the library as files under the host's `tmp`, deleted after the answer.
 */

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { requestAborted } from '../../../server/public/exchange.js'
import {
  completionBody,
  notServed,
  OpenAiRequestError,
  readJsonBody,
  sendJson,
  sendOpenAiError,
  SSE_DONE,
  sseFramer,
} from '../../shared/index.js'
import type { Delta, FinishReason, ModelCaps } from '../../shared/index.js'
import { FifoLock } from '../../litert-lm/host/pool.js'
import type { GeniexEngine } from './engine.js'
import { jsonSchemaToGrammar } from './grammar.js'
import { GeniexLibraryError } from './library.js'
import type { GeniexGenerationConfig, GeniexStopReason } from './library.js'
import { GeniexReplyParser, IMAGE_PLACEHOLDER, parseGeniexChatRequest } from './openai.js'
import type { ParsedGeniexChat } from './openai.js'

export interface GeniexServerOptions {
  engine: GeniexEngine
  /** What `/v1/models` lists and replies carry as `model`: core's session id. */
  modelId: string
  caps: ModelCaps
  /** The `max_tokens` of a request that names none. */
  defaultMaxTokens: number
  /** Where request images are written for the library. */
  tmpDir: string
  now?: () => number
  /** One line per failed generation, for the host's stderr (core keeps its tail). */
  log?: (line: string) => void
}

export interface GeniexServer {
  /** Listen on loopback; the base URL (`http://127.0.0.1:<port>`). */
  listen(port: number): Promise<string>
  /** Stop accepting, cancel what runs, wait for it to end. */
  close(): Promise<void>
}

/** How long a stop waits for a cancelled generation to end in the library. */
const CLOSE_WAIT_MS = 10_000
const GONE_POLL_MS = 50
const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
}

export function createGeniexServer(options: GeniexServerOptions): GeniexServer {
  const now = options.now ?? Date.now
  const lock = new FifoLock()
  /** The generation under way, if any: its cancel flag and a promise for its end. */
  let running: { cancel: Int32Array; ended: Promise<void> } | null = null
  let counter = 0
  let closed = false

  const server = createServer((req, res) => {
    void route(req, res).catch((error: unknown) => {
      if (res.headersSent) return res.destroy()
      sendOpenAiError(
        res,
        error instanceof OpenAiRequestError
          ? error
          : new OpenAiRequestError(500, error instanceof Error ? error.message : String(error))
      )
    })
  })

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '/').split('?')[0] ?? '/'
    if (req.method === 'GET' && path === '/v1/models')
      return sendJson(res, 200, {
        object: 'list',
        data: [
          { id: options.modelId, object: 'model', created: Math.floor(now() / 1000), owned_by: 'geniex' },
        ],
      })
    if (req.method === 'POST' && path === '/v1/chat/completions') {
      const chat = parseGeniexChatRequest(await readJsonBody(req), options.caps)
      let hungUp = false
      res.on('close', () => {
        if (!res.writableFinished) hungUp = true
      })
      // Bun never says the response closed once the body is read; only its native handle knows (ADR
      // 2026-09-22-detect-a-client-that-hangs-up-before-the-answer-under-bun), polled while it runs.
      const gone = () => hungUp || requestAborted(req, res)
      return lock.run(async () => {
        if (gone() || closed) return
        await generate(chat, res, gone)
      })
    }
    sendOpenAiError(res, notServed(req.method ?? 'GET', path, 'GenieX'))
  }

  /** The request's images as files; the paths in the order the content numbered them. */
  async function writeImages(chat: ParsedGeniexChat, id: string): Promise<string[]> {
    if (chat.images.length === 0) return []
    await mkdir(options.tmpDir, { recursive: true })
    return Promise.all(
      chat.images.map(async (image, index) => {
        const path = join(options.tmpDir, `${id}-${index}.${MIME_EXT[image.mime] ?? 'img'}`)
        await writeFile(path, Buffer.from(image.base64, 'base64'))
        return path
      })
    )
  }

  async function generate(chat: ParsedGeniexChat, res: ServerResponse, gone: () => boolean): Promise<void> {
    const framer = sseFramer(
      `chatcmpl-${now().toString(36)}${(counter++).toString(36)}`,
      Math.floor(now() / 1000),
      options.modelId
    )
    const images = await writeImages(chat, framer.id)
    const messages = chat.messages.map((message) => ({
      ...message,
      content: message.content.map((part) =>
        part.type === 'image'
          ? {
              type: 'image' as const,
              path: images[chat.images.findIndex((_, i) => IMAGE_PLACEHOLDER(i) === part.path)] ?? part.path,
            }
          : part
      ),
    }))
    const parser = new GeniexReplyParser(chat.stop, chat.tools !== null)
    const cancel = new Int32Array(new SharedArrayBuffer(4))
    let settle: () => void = () => {}
    running = { cancel, ended: new Promise<void>((done) => (settle = done)) }
    const stream = chat.stream
    const write = (deltas: Delta[]) => {
      if (stream && !gone()) for (const delta of deltas) res.write(framer.delta(delta))
    }
    let promptTokens = 0
    let stopReason: GeniexStopReason = 'unknown'
    let failure: OpenAiRequestError | null = null
    const watch = setInterval(() => {
      if (gone()) Atomics.store(cancel, 0, 1)
    }, GONE_POLL_MS)
    try {
      const prompt = await options.engine.applyChatTemplate({
        messages,
        tools: chat.toolsJson,
        enableThinking: chat.thinking,
      })
      if (stream && !gone()) {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          'connection': 'keep-alive',
        })
        res.write(framer.delta({ role: 'assistant', content: '' }))
      }
      const config: GeniexGenerationConfig = {
        maxTokens: chat.maxTokens ?? options.defaultMaxTokens,
        // The library sees the stop strings too; the parser still cuts the text at them.
        stop: chat.stop,
        sampler: {
          ...(chat.sampler.temperature !== undefined ? { temperature: chat.sampler.temperature } : {}),
          ...(chat.sampler.topP !== undefined ? { topP: chat.sampler.topP } : {}),
          ...(chat.sampler.topK !== undefined ? { topK: chat.sampler.topK } : {}),
          ...(chat.sampler.seed !== undefined ? { seed: chat.sampler.seed } : {}),
          grammar: chat.responseFormat
            ? jsonSchemaToGrammar(JSON.parse(chat.responseFormat.value) as unknown)
            : null,
        },
        imagePaths: images,
      }
      const result = await options.engine.generate(
        prompt,
        config,
        (token) => {
          write(parser.add(token))
          if (parser.stopped) Atomics.store(cancel, 0, 1)
        },
        cancel
      )
      promptTokens = result.promptTokens
      stopReason = parser.stopped ? 'user' : result.stopReason
    } catch (error) {
      failure =
        error instanceof OpenAiRequestError
          ? error
          : new OpenAiRequestError(
              500,
              `GenieX: ${error instanceof GeniexLibraryError ? error.message : error instanceof Error ? error.message : String(error)}`
            )
      options.log?.(`generation failed: ${failure.message}`)
    } finally {
      clearInterval(watch)
      running = null
      settle()
      await Promise.all(images.map((path) => rm(path, { force: true }).catch(() => {})))
    }
    if (gone()) return
    write(parser.flush())
    const finish: FinishReason | null = failure ? null : parser.finish(stopReason)
    const usage = {
      prompt_tokens: promptTokens,
      completion_tokens: parser.tokens,
      total_tokens: promptTokens + parser.tokens,
    }
    if (stream) {
      if (!res.headersSent) {
        if (failure) return sendOpenAiError(res, failure)
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          'connection': 'keep-alive',
        })
      }
      if (failure) res.write(`data: ${JSON.stringify(failure.body)}\n\n`)
      else {
        res.write(framer.delta({}, finish))
        if (chat.includeUsage) res.write(framer.frame({ choices: [], usage }))
      }
      res.end(SSE_DONE)
      return
    }
    if (failure) return sendOpenAiError(res, failure)
    sendJson(res, 200, completionBody(framer, options.modelId, parser.message(), finish, usage))
  }

  return {
    listen: (port) =>
      new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', () => {
          server.off('error', reject)
          resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
        })
      }),
    close: async () => {
      closed = true
      // A model destroyed while the library still generates is a use-after-free in the Worker: cancel,
      // then wait for the generation's end (bounded).
      const current = running
      if (current) {
        Atomics.store(current.cancel, 0, 1)
        await Promise.race([
          current.ended,
          new Promise((resolve) => setTimeout(resolve, CLOSE_WAIT_MS).unref()),
        ])
      }
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
