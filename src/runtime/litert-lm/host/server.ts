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
import { OpenAiRequestError, parseChatRequest, ReplyBuilder } from './openai.js'
import type { Delta, FinishReason, ModelCaps, ParsedChat } from './openai.js'
import type { LiteRtChunk, LiteRtConversation, LiteRtEngine } from './library.js'
import { ConversationPool, FifoLock } from './pool.js'

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

/** Images arrive inline as base64. */
const BODY_LIMIT = 64 * 1024 * 1024

class BodyTooLarge extends Error {}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > BODY_LIMIT) {
        reject(new BodyTooLarge())
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

const sendError = (res: ServerResponse, error: OpenAiRequestError) => sendJson(res, error.status, error.body)

export function createLiteRtServer(options: LiteRtServerOptions): LiteRtServer {
  const now = options.now ?? Date.now
  const lock = new FifoLock()
  const pool = new ConversationPool<LiteRtConversation>((config) => options.engine.conversation(config))
  const running = new Set<LiteRtConversation>()
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
    const path = (req.url ?? '/').split('?')[0]
    if (req.method === 'GET' && path === '/v1/models')
      return sendJson(res, 200, {
        object: 'list',
        data: [
          { id: options.modelId, object: 'model', created: Math.floor(now() / 1000), owned_by: 'litert-lm' },
        ],
      })
    if (req.method === 'POST' && path === '/v1/chat/completions') {
      let raw: unknown
      try {
        raw = JSON.parse(await readBody(req)) as unknown
      } catch (error) {
        throw error instanceof BodyTooLarge
          ? new OpenAiRequestError(413, 'The request body is too large.')
          : new OpenAiRequestError(400, 'The request body is not valid JSON.')
      }
      const chat = parseChatRequest(raw, options.caps)
      let gone = false
      res.on('close', () => {
        if (!res.writableFinished) gone = true
      })
      return lock.run(async () => {
        if (gone) return
        await generate(chat, res, () => gone)
      })
    }
    sendError(
      res,
      new OpenAiRequestError(
        404,
        `${req.method ?? 'GET'} ${path} is not served by LiteRT-LM.`,
        null,
        'invalid_request_error',
        'not_found'
      )
    )
  }

  /** One generation, resolved when the library's last chunk has been handled. */
  function generate(chat: ParsedChat, res: ServerResponse, gone: () => boolean): Promise<void> {
    const { conversation, entry } = pool.take(chat.history, {
      tools: chat.tools,
      sampler: chat.sampler,
      constrained: chat.responseFormat !== null,
    })
    const reply = new ReplyBuilder(chat.stop)
    const id = `chatcmpl-${now().toString(36)}${(counter++).toString(36)}`
    const created = Math.floor(now() / 1000)
    const frame = (body: Record<string, unknown>) =>
      `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: options.modelId, ...body })}\n\n`
    const deltaFrame = (delta: Record<string, unknown>, finish: FinishReason | null = null) =>
      frame({ choices: [{ index: 0, delta, finish_reason: finish }] })
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
          res.end('data: [DONE]\n\n')
          return
        }
        if (failure) return sendError(res, failure)
        sendJson(res, 200, {
          id,
          object: 'chat.completion',
          created,
          model: options.modelId,
          choices: [{ index: 0, message: reply.message(), finish_reason: finish }],
          usage,
        })
      }
      try {
        running.add(conversation)
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
        pool.drop(entry)
        const failure = new OpenAiRequestError(500, error instanceof Error ? error.message : String(error))
        options.log?.(`generation failed to start: ${failure.message}`)
        if (chat.stream) {
          res.write(`data: ${JSON.stringify(failure.body)}\n\n`)
          res.end('data: [DONE]\n\n')
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
    close: () =>
      new Promise((resolve) => {
        for (const conversation of running) conversation.cancel()
        server.closeAllConnections()
        server.close(() => {
          pool.closeAll()
          resolve()
        })
      }),
  }
}
