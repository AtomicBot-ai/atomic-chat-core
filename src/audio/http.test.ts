import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AudioTimeoutError, createAudioHttpClient } from './http.js'

let server: Server
let base: string
let seen: Array<{
  method: string
  url: string
  type: string | undefined
  length: string | undefined
  body: string
}>

beforeEach(async () => {
  seen = []
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      seen.push({
        method: req.method ?? '',
        url: req.url ?? '',
        type: req.headers['content-type'],
        length: req.headers['content-length'],
        body: Buffer.concat(chunks).toString('utf8'),
      })
      if (req.url === '/wav') {
        res.writeHead(200, { 'content-type': 'audio/wav' })
        return res.end(Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0xff]))
      }
      if (req.url === '/big') {
        // A long song's answer: the JSON runs to many megabytes.
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ audio: 'A'.repeat(24 * 1024 * 1024) }))
      }
      if (req.url === '/slow') return void setTimeout(() => res.end('late'), 2_000)
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end('{"error":{"message":"no"}}')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterEach(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('createAudioHttpClient', () => {
  it('answers the status, the content type and the bytes as they came', async () => {
    const http = createAudioHttpClient()
    const wav = await http.get(`${base}/wav`, { timeoutMs: 5_000 })
    expect(wav).toEqual({
      status: 200,
      contentType: 'audio/wav',
      body: Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0xff]),
    })
    const refused = await http.post(`${base}/speech`, { model: 'm', input: 'Привет' }, { timeoutMs: 5_000 })
    expect(refused.status).toBe(500)
    expect(refused.body.toString('utf8')).toBe('{"error":{"message":"no"}}')
    expect(seen[1]).toEqual({
      method: 'POST',
      url: '/speech',
      type: 'application/json',
      length: String(Buffer.byteLength('{"model":"m","input":"Привет"}')),
      body: '{"model":"m","input":"Привет"}',
    })
  })

  it('reads an answer of many megabytes whole', async () => {
    const answer = await createAudioHttpClient().post(`${base}/big`, {}, { timeoutMs: 30_000 })
    expect(answer.body.length).toBe(24 * 1024 * 1024 + '{"audio":""}'.length)
  })

  it('throws a timeout past the deadline, and the abort when the caller stops it', async () => {
    const http = createAudioHttpClient()
    await expect(http.get(`${base}/slow`, { timeoutMs: 100 })).rejects.toBeInstanceOf(AudioTimeoutError)
    const controller = new AbortController()
    const pending = http.post(`${base}/slow`, {}, { timeoutMs: 5_000, signal: controller.signal })
    setTimeout(() => controller.abort(), 50)
    const error = await pending.catch((e: unknown) => e)
    expect(error).not.toBeInstanceOf(AudioTimeoutError)
    expect(error).toBeInstanceOf(Error)
    const already = new AbortController()
    already.abort()
    await expect(
      http.get(`${base}/wav`, { timeoutMs: 5_000, signal: already.signal })
    ).rejects.toBeInstanceOf(Error)
  })
})
