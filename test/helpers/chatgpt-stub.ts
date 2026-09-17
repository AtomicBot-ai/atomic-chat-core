/**
 * Local stand-ins for `auth.openai.com` and `chatgpt.com/backend-api/codex`, so sign-in, refresh and
 * the subscription route can be exercised end to end without the network.
 */

import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export function jwt(payload: object): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${part({ alg: 'none' })}.${part(payload)}.sig`
}

export function accessTokenFor(account: string, n = 1): string {
  return jwt({ n, 'https://api.openai.com/auth': { chatgpt_account_id: account, chatgpt_plan_type: 'plus' } })
}

export interface StubRequest {
  method: string
  path: string
  headers: IncomingMessage['headers']
  body: string
}

export type StubHandler = (req: StubRequest, res: ServerResponse) => void

export interface Stub {
  url: string
  port: number
  requests: StubRequest[]
  handle: (handler: StubHandler) => void
  close: () => Promise<void>
}

/** A server that records every request and answers with whatever handler is current. */
export async function startStub(initial: StubHandler): Promise<Stub> {
  const requests: StubRequest[] = []
  let handler = initial
  const server: Server = createServer((req, res) => {
    let body = ''
    req.on('data', (c: Buffer) => (body += c.toString()))
    req.on('end', () => {
      const recorded = { method: req.method ?? '', path: req.url ?? '', headers: req.headers, body }
      requests.push(recorded)
      handler(recorded, res)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    handle: (next) => (handler = next),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** A Responses API event stream the way the subscription sends it. */
export function responsesStream(text: string): string {
  const events = [
    { type: 'response.created', response: { id: 'resp_1' } },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'message', id: 'msg_1', role: 'assistant', content: [] },
    },
    { type: 'response.output_text.delta', output_index: 0, item_id: 'msg_1', delta: text },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text }] },
    },
    {
      type: 'response.completed',
      response: {
        id: 'resp_1',
        status: 'completed',
        usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
      },
    },
  ]
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
}
