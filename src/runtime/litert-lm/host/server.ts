/**
 * The host's own OpenAI server (design D5, tasks 5.4–5.5): `GET /v1/models` and
 * `POST /v1/chat/completions` on `127.0.0.1:<port>`, with no authentication — core's session gateway
 * is the only door in, and it checks the key. Generations run one at a time in arrival order
 * (`FifoLock`); conversations stay warm in a `ConversationPool`.
 *
 * A client that hangs up cancels its generation in the library; a stop string cancels it too. A
 * cancelled conversation answers every later message with `CANCELLED` (spike S2), so it leaves the
 * pool, as does one whose generation failed.
 */

import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { requestAborted } from '../../../server/public/exchange.js'
import {
  completionBody,
  notServed,
  readJsonBody,
  sendJson,
  sendOpenAiError,
  SSE_DONE,
  sseFramer,
} from '../../shared/index.js'
import { OpenAiRequestError, parseChatRequest, ReplyBuilder } from './openai.js'
import type { Delta, FinishReason, ModelCaps, ParsedChat } from './openai.js'
import type { LiteRtChunk, LiteRtConversation, LiteRtEngine } from './library.js'
import { ConversationPool, FifoLock } from './pool.js'

const sendError = sendOpenAiError

export interface LiteRtServerOptions {
  engine: LiteRtEngine
  /** What `/v1/models` lists and replies carry as `model`: core's session id. */
  modelId: string
  caps: ModelCaps
  now?: () => number
  /** One line per failed generation, for the host's stderr (core keeps its tail). */
  log?: (line: string) => void
}

export interface LiteRtServer {
  /** Listen on loopback; the base URL (`http://127.0.0.1:<port>`). */
  listen(port: number): Promise<string>
  /** Stop accepting, cancel what runs, close every conversation. */
  close(): Promise<void>
}

/** How long a stop waits for cancelled generations to end in the library. */
const CLOSE_WAIT_MS = 10_000

export function createLiteRtServer(options: LiteRtServerOptions): LiteRtServer {
  const now = options.now ?? Date.now
  const lock = new FifoLock()
  const pool = new ConversationPool<LiteRtConversation>((config) => options.engine.conversation(config))
  /** Generations under way, each resolved when the library's last chunk has been handled. */
  const running = new Map<LiteRtConversation, Promise<void>>()
  let counter = 0

  const server = createServer((req, res) => {
    void route(req, res).catch((error: unknown) => {
      if (res.headersSent) return res.destroy()
      sendError(
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
          { id: options.modelId, object: 'model', created: Math.floor(now() / 1000), owned_by: 'litert-lm' },
        ],
      })
    if (req.method === 'POST' && path === '/v1/chat/completions') {
      const chat = parseChatRequest(await readJsonBody(req), options.caps)
      let closed = false
      res.on('close', () => {
        if (!res.writableFinished) closed = true
      })
      // Bun never says the response closed once the body is read; only its native handle knows (ADR
      // 2026-09-22-detect-a-client-that-hangs-up-before-the-answer-under-bun), polled by `watchGone`.
      const gone = () => closed || requestAborted(req, res)
      return lock.run(async () => {
        if (gone()) return
        await generate(chat, res, gone)
      })
    }
    sendError(res, notServed(req.method ?? 'GET', path, 'LiteRT-LM'))
  }

  /** One generation, resolved when the library's last chunk has been handled. */
  function generate(chat: ParsedChat, res: ServerResponse, gone: () => boolean): Promise<void> {
    const { conversation, entry } = pool.take(chat.history, {
      tools: chat.tools,
      sampler: chat.sampler,
      constrained: chat.responseFormat !== null,
    })
    const reply = new ReplyBuilder(chat.stop)
    const framer = sseFramer(
      `chatcmpl-${now().toString(36)}${(counter++).toString(36)}`,
      Math.floor(now() / 1000),
      options.modelId
    )
    const frame = framer.frame
    const deltaFrame = (delta: Record<string, unknown>, finish: FinishReason | null = null) =>
      framer.delta(delta, finish)
    if (chat.stream) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'connection': 'keep-alive',
      })
      res.write(deltaFrame({ role: 'assistant', content: '' }))
    }
    const write = (deltas: Delta[]) => {
      if (chat.stream && !gone()) for (const delta of deltas) res.write(deltaFrame(delta))
    }

    return new Promise<void>((resolve) => {
      let cancelled = false
      const cancel = () => {
        if (cancelled) return
        cancelled = true
        conversation.cancel()
      }
      const watchGone = setInterval(() => {
        if (gone()) cancel()
      }, 50)
      const done = (chunk: LiteRtChunk) => {
        clearInterval(watchGone)
        running.delete(conversation)
        settle()
        write(reply.flush())
        let finish: FinishReason | null = null
        let failure: OpenAiRequestError | null = null
        try {
          finish = gone() ? null : reply.finish(chunk.error)
        } catch (error) {
          failure = error instanceof OpenAiRequestError ? error : new OpenAiRequestError(500, String(error))
          options.log?.(`generation failed: ${failure.message}`)
        }
        const total = conversation.tokenCount()
        const usage = {
          prompt_tokens: Math.max(0, total - reply.completionChunks),
          completion_tokens: reply.completionChunks,
          total_tokens: total,
        }
        if (cancelled || failure || chunk.error) pool.drop(entry)
        else pool.advance(entry, [...chat.next, reply.history()])
        if (!gone()) respond(finish, failure, usage)
        resolve()
      }
      const respond = (
        finish: FinishReason | null,
        failure: OpenAiRequestError | null,
        usage: Record<string, number>
      ) => {
        if (chat.stream) {
          if (failure) res.write(`data: ${JSON.stringify(failure.body)}\n\n`)
          else {
            res.write(deltaFrame({}, finish))
            if (chat.includeUsage) res.write(frame({ choices: [], usage }))
          }
          res.end(SSE_DONE)
          return
        }
        if (failure) return sendError(res, failure)
        sendJson(res, 200, completionBody(framer, options.modelId, reply.message(), finish, usage as never))
      }
      let settle: () => void = () => {}
      running.set(conversation, new Promise<void>((done) => (settle = done)))
      try {
        conversation.send(
          chat.next,
          {
            ...(chat.maxTokens !== undefined ? { maxOutputTokens: chat.maxTokens } : {}),
            ...(chat.responseFormat ? { constraint: chat.responseFormat } : {}),
            thinking: chat.thinking,
          },
          (chunk) => {
            if (chunk.text !== null && !chunk.error) {
              write(reply.add(chunk.text))
              if (reply.stopped) cancel()
            }
            if (chunk.final || chunk.error) done(chunk)
          }
        )
      } catch (error) {
        clearInterval(watchGone)
        running.delete(conversation)
        settle()
        pool.drop(entry)
        const failure = new OpenAiRequestError(500, error instanceof Error ? error.message : String(error))
        options.log?.(`generation failed to start: ${failure.message}`)
        if (chat.stream) {
          res.write(`data: ${JSON.stringify(failure.body)}\n\n`)
          res.end(SSE_DONE)
        } else sendError(res, failure)
        resolve()
      }
    })
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
      // A conversation or engine deleted while the library still runs its generation is a
      // use-after-free on the library's thread: cancel, then wait for each last chunk (bounded).
      const pending = [...running.entries()]
      for (const [conversation] of pending) conversation.cancel()
      await Promise.race([
        Promise.all(pending.map(([, ended]) => ended)),
        new Promise((resolve) => setTimeout(resolve, CLOSE_WAIT_MS).unref()),
      ])
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      pool.closeAll()
    },
  }
}
