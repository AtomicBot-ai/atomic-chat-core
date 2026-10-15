/**
 * The fake llama-server (test/helpers/fake-llama-server.mjs) against what a real build said: every
 * file in test/fixtures/llamacpp/observed/ is the `golden` section of an `observed.json` the live
 * contract probe (test/live/llamacpp-contract.test.ts) wrote — the startup and ready lines, the 401,
 * the 501s of a route the server was not started for, the context-overflow envelope and the
 * `--version` shape. The fake must say the same, so every suite that runs on it runs on the real
 * wording. A new capture is `jq '{schema: "atomic-engine-observed-golden", schema_version: 1, engine,
 * tag, build, host, golden}' observed.json > test/fixtures/llamacpp/observed/<tag>-<backend>.json`.
 */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { afterEach, describe, expect, it } from 'vitest'
import { FAKE_LLAMA_SCRIPT } from '../helpers/fake-llama-server.js'
import { stableLine } from '../helpers/llamacpp-observed.js'
import { parseBinaryVersion } from '../../src/backend/version.js'

interface Answer {
  status: number
  body: unknown
}

interface Golden {
  file: string
  tag: string
  golden: {
    'version': string
    'startup_head': string[]
    'ready_line': string
    'unauthorized': Answer
    'refused.metrics': Answer
    'refused.embeddings': Answer
    'metrics_with_flag': { status: number; content_type: string }
    'context_overflow': Answer
  }
}

const DIR = new URL('../fixtures/llamacpp/observed/', import.meta.url)
const goldens: Golden[] = readdirSync(DIR)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((file) => ({
    file,
    ...(JSON.parse(readFileSync(new URL(file, DIR), 'utf8')) as Omit<Golden, 'file'>),
  }))

const KEY = 'probe-key'
const running: ChildProcess[] = []

afterEach(() => {
  for (const child of running.splice(0)) child.kill()
})

/** Start the fake as core would (its argv, LLAMA_API_KEY) and wait for the line that says it is up. */
async function startFake(
  args: string[],
  env: Record<string, string> = {}
): Promise<{ port: number; lines: string[] }> {
  const child = spawn(
    process.execPath,
    [FAKE_LLAMA_SCRIPT, '--port', '0', '-m', '/m.gguf', '-a', 'probe', ...args],
    {
      env: { ...process.env, LLAMA_API_KEY: KEY, ...env },
      stdio: ['ignore', 'ignore', 'pipe'],
    }
  )
  running.push(child)
  const lines: string[] = []
  const port = await new Promise<number>((resolve, reject) => {
    child.once('exit', (code) => reject(new Error(`the fake exited (${code}):\n${lines.join('\n')}`)))
    createInterface({ input: child.stderr! }).on('line', (line) => {
      lines.push(line)
      const bound = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(line)
      if (bound) resolve(Number(bound[1]))
    })
  })
  return { port, lines }
}

async function ask(
  port: number,
  path: string,
  options: { key?: string | null; body?: unknown } = {}
): Promise<{ status: number; contentType: string | null; body: unknown }> {
  const key = options.key === undefined ? KEY : options.key
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: options.body === undefined ? 'GET' : 'POST',
    headers: {
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })
  const text = await res.text()
  let body: unknown = text
  try {
    body = JSON.parse(text)
  } catch {
    // Prometheus text stays text.
  }
  return { status: res.status, contentType: res.headers.get('content-type'), body }
}

/** An error envelope with its numbers left out: they depend on the prompt and the window. */
function shape(body: unknown): unknown {
  if (typeof body === 'string') return body.replace(/\d+/g, 'N')
  if (typeof body === 'number') return 'number'
  if (body === null || typeof body !== 'object') return body
  return Object.fromEntries(
    Object.entries(body as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, shape(v)])
  )
}

describe.each(goldens)('the fake llama-server against $file', ({ golden }) => {
  it('prints the startup and ready lines a real build prints at its default verbosity', async () => {
    const { lines } = await startFake([])
    const stable = lines.map(stableLine)
    expect(stable.slice(0, golden.startup_head.length)).toEqual(golden.startup_head)
    expect(stable).toContain(golden.ready_line)
  })

  it('locks every route but /health behind the key, in the same words', async () => {
    const { port } = await startFake([])
    expect((await ask(port, '/health', { key: null })).status).toBe(200)
    const models = await ask(port, '/v1/models', { key: null })
    expect({ status: models.status, body: models.body }).toEqual(golden.unauthorized)
    expect((await ask(port, '/v1/models')).status).toBe(200)
  })

  it('refuses /metrics and /v1/embeddings it was not started for, in the same words', async () => {
    const { port } = await startFake([])
    const metrics = await ask(port, '/metrics')
    expect({ status: metrics.status, body: metrics.body }).toEqual(golden['refused.metrics'])
    const embeddings = await ask(port, '/v1/embeddings', { body: { input: 'hi' } })
    expect({ status: embeddings.status, body: embeddings.body }).toEqual(golden['refused.embeddings'])
  })

  it('serves Prometheus text on /metrics when started with --metrics', async () => {
    const { port } = await startFake(['--metrics'])
    const metrics = await ask(port, '/metrics')
    expect({ status: metrics.status, content_type: metrics.contentType }).toEqual(golden.metrics_with_flag)
  })

  it('refuses a prompt larger than its context with the same envelope', async () => {
    const { port } = await startFake(['--ctx-size', '256'], { FAKE_LLAMA_MIN_CTX: '4096' })
    const overflow = await ask(port, '/v1/chat/completions', {
      body: { messages: [{ role: 'user', content: 'hello' }] },
    })
    expect(overflow.status).toBe(golden.context_overflow.status)
    expect(shape(overflow.body)).toEqual(shape(golden.context_overflow.body))
  })

  it('prints --version in the shape core reads the build from', async () => {
    const child = spawn(process.execPath, [FAKE_LLAMA_SCRIPT, '--version'], {
      env: { ...process.env, FAKE_LLAMA_BUILD: '11642' },
    })
    let output = ''
    child.stdout.on('data', (d: Buffer) => (output += d.toString()))
    child.stderr.on('data', (d: Buffer) => (output += d.toString()))
    await new Promise((resolve) => child.once('exit', resolve))
    const versionLine = /^version: \S+ \(build \d+, commit [0-9a-f]+\)$/m
    expect(golden.version).toMatch(versionLine)
    expect(output).toMatch(versionLine)
    expect(parseBinaryVersion(output)).toBe(11642)
  })
})
