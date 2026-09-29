/**
 * The compiled core on a real Linux machine, for the managed TensorRT-LLM live tests (install, task
 * 2.18; engine, task 2.19): start a daemon either in the test's own session or in a fresh login's
 * group set, talk to its control API, follow its event stream, stream a chat from it, and stop it
 * without leaving it behind.
 *
 * HTTP goes through `node:http`, not `fetch`: a TensorRT-LLM load can take longer than undici's
 * fixed five-minute headers timeout, and a load that "failed" because the test's client gave up would
 * be a false result.
 *
 * No imports from `src/`: the live test drives the binary only, the way the app and the CLI do.
 */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import http from 'node:http'
import { join } from 'node:path'

export interface ReadyLine {
  event: string
  pid: number
  instance_id: string
  version: string
  control_host: string
  control_port: number
}

export interface HttpAnswer<T> {
  status: number
  body: T
  text: string
}

interface RawRequest {
  url: string
  method: string
  headers?: Record<string, string>
  body?: string
  /** 0 = no deadline. */
  timeoutMs: number
  onChunk?: (chunk: string) => void
}

/** One HTTP exchange; resolves with the whole body (also streamed through `onChunk`). */
export function httpRequest(
  req: RawRequest
): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(req.url)
    const request = http.request(
      {
        host: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: req.method,
        headers: {
          ...(req.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(req.headers ?? {}),
        },
      },
      (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          text += chunk
          req.onChunk?.(chunk)
        })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }))
        res.on('error', reject)
      }
    )
    request.on('error', reject)
    if (req.timeoutMs > 0) {
      request.setTimeout(req.timeoutMs, () =>
        request.destroy(new Error(`${req.method} ${url.pathname} took longer than ${req.timeoutMs} ms`))
      )
    }
    if (req.body !== undefined) request.write(req.body)
    request.end()
  })
}

export interface StreamedChat {
  status: number
  headers: http.IncomingHttpHeaders
  /** The raw SSE body, `data: [DONE]` included. */
  text: string
  /** `delta.content` of every chunk, joined. */
  content: string
  /** `delta.reasoning_content` of every chunk, joined (a reasoning parser splits the thinking out). */
  reasoning: string
  /** From the request to the first chunk carrying content or reasoning; null when none came. */
  first_token_ms: number | null
  total_ms: number
}

/**
 * One streamed `POST /v1/chat/completions` (`stream: true` in `body`), read chunk by chunk as it
 * arrives, so the time to the first token is the client's own, not the end of the body's.
 */
export async function streamChat(options: {
  url: string
  body: Record<string, unknown>
  timeoutMs: number
}): Promise<StreamedChat> {
  const started = Date.now()
  let firstTokenMs: number | null = null
  let content = ''
  let reasoning = ''
  let pending = ''
  const answer = await httpRequest({
    url: options.url,
    method: 'POST',
    body: JSON.stringify(options.body),
    timeoutMs: options.timeoutMs,
    onChunk: (chunk) => {
      pending += chunk
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) {
        const data = /^data: (.*)$/.exec(line.trim())?.[1]
        if (data === undefined || data === '[DONE]') continue
        try {
          const delta = (
            JSON.parse(data) as {
              choices?: Array<{ delta?: { content?: string; reasoning_content?: string } }>
            }
          ).choices?.[0]?.delta
          const text = `${delta?.content ?? ''}${delta?.reasoning_content ?? ''}`
          if (text !== '' && firstTokenMs === null) firstTokenMs = Date.now() - started
          content += delta?.content ?? ''
          reasoning += delta?.reasoning_content ?? ''
        } catch {
          // A partial or non-JSON line is not a token.
        }
      }
    },
  })
  return {
    status: answer.status,
    headers: answer.headers,
    text: answer.text,
    content,
    reasoning,
    first_token_ms: firstTokenMs,
    total_ms: Date.now() - started,
  }
}

/**
 * What a chat request adds to turn a reasoning model's thinking off: the chat template's own switch
 * (Qwen3's `enable_thinking`), which closes the think block in the prompt itself. Qwen3's `/no_think`
 * soft switch is not used: TRT-LLM 1.2.1's `qwen3` reasoning parser (`DeepSeekR1Parser` with
 * `reasoning_at_start=False`) only ends reasoning at `</think>`, and Qwen3-1.7B answers `/no_think` with
 * an opening `<think>` it never closes, so the whole answer, a tool call included, lands in
 * `reasoning_content` (seen 4 of 4 times on the first live run; 3 of 3 tool calls parsed with this).
 * A template without the variable ignores it.
 */
export const THINKING_OFF = { chat_template_kwargs: { enable_thinking: false } } as const

/**
 * The `tensorrt-llm` settings a context-length override needs: `context_length`, and
 * `max_output_tokens` at half of it (at most 4096, the provider's default) so the output cap stays
 * below the context. Empty without an override.
 */
export function contextLengthSettings(contextLength: number | null): Record<string, number> {
  if (contextLength === null) return {}
  return { context_length: contextLength, max_output_tokens: Math.min(4096, Math.floor(contextLength / 2)) }
}

export class ControlApi {
  constructor(
    private readonly dataFolder: string,
    readonly ready: ReadyLine
  ) {}

  get base(): string {
    return `http://${this.ready.control_host}:${this.ready.control_port}/atomic/v1`
  }

  private token(): string {
    return readFileSync(join(this.dataFolder, 'atomic-core', 'control-token'), 'utf8').trim()
  }

  async call<T>(method: string, path: string, body?: unknown, timeoutMs = 60_000): Promise<HttpAnswer<T>> {
    const answer = await httpRequest({
      url: `${this.base}${path}`,
      method,
      headers: { authorization: `Bearer ${this.token()}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      timeoutMs,
    })
    let parsed: unknown = null
    try {
      parsed = answer.text === '' ? null : JSON.parse(answer.text)
    } catch {
      parsed = null
    }
    return { status: answer.status, body: parsed as T, text: answer.text }
  }

  get<T>(path: string, timeoutMs?: number): Promise<HttpAnswer<T>> {
    return this.call<T>('GET', path, undefined, timeoutMs)
  }

  post<T>(path: string, body: unknown = {}, timeoutMs?: number): Promise<HttpAnswer<T>> {
    return this.call<T>('POST', path, body, timeoutMs)
  }

  patch<T>(path: string, body: unknown, timeoutMs?: number): Promise<HttpAnswer<T>> {
    return this.call<T>('PATCH', path, body, timeoutMs)
  }

  /**
   * Follows `/events` (SSE) until `close()`: every frame's event name and parsed data. The stream is
   * the app's own view of an operation, so the phase log is taken from it rather than from polling,
   * which would miss a phase shorter than its interval. The cursor `<instance_id>:0` replays what
   * this core emitted before the subscription, so a core that resumes an operation at startup (the
   * relogin) cannot slip a phase past the log. A dropped stream (hours of pulling) reconnects after a
   * second with the last `id:` it saw, which replays whatever it missed from the core's ring.
   */
  events(onFrame: (event: string, data: unknown) => void): { close: () => void } {
    let cursor = `${this.ready.instance_id}:0`
    let closed = false
    let request: http.ClientRequest | null = null
    let timer: NodeJS.Timeout | null = null
    const reconnect = (): void => {
      if (closed || timer !== null) return
      timer = setTimeout(() => {
        timer = null
        connect()
      }, 1000)
    }
    const connect = (): void => {
      if (closed) return
      const url = new URL(`${this.base}/events?cursor=${encodeURIComponent(cursor)}`)
      let pending = ''
      let token: string
      try {
        token = this.token()
      } catch {
        reconnect()
        return
      }
      request = http.request(
        {
          host: url.hostname,
          port: url.port,
          path: `${url.pathname}${url.search}`,
          method: 'GET',
          headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
        },
        (res) => {
          res.setEncoding('utf8')
          res.on('data', (chunk: string) => {
            pending += chunk
            const frames = pending.split('\n\n')
            pending = frames.pop() ?? ''
            for (const frame of frames) {
              const id = /^id: (.*)$/m.exec(frame)?.[1]
              if (id !== undefined && id !== '') cursor = id
              const event = /^event: (.*)$/m.exec(frame)?.[1]
              const data = /^data: (.*)$/m.exec(frame)?.[1]
              if (event === undefined || data === undefined) continue
              try {
                onFrame(event, JSON.parse(data))
              } catch {
                // A frame that is not JSON is not an operation update.
              }
            }
          })
          res.on('error', reconnect)
          res.on('end', reconnect)
        }
      )
      request.on('error', reconnect)
      request.end()
    }
    connect()
    return {
      close: () => {
        closed = true
        if (timer !== null) clearTimeout(timer)
        request?.destroy()
      },
    }
  }
}

export interface LiveCore {
  /** `first` for the session the test runs in, `relogin` for the fresh login's. */
  label: string
  ready: ReadyLine
  api: ControlApi
  child: ChildProcess
  stop(): Promise<void>
}

export interface StartLiveCoreOptions {
  label: string
  bin: string
  dataFolder: string
  /** Exactly the core's environment additions; nothing else of the test's environment is special. */
  env: Record<string, string>
  /** stdout and stderr of the core are appended here. */
  logFile: string
  /**
   * Start it the way a fresh login would: `sudo -u <user>` runs it through `initgroups(3)`, so it
   * carries the supplementary groups `/etc/group` lists now — the same call `login`, `sshd` and the
   * display manager make when a session begins — instead of the ones this test process inherited.
   */
  freshLoginAs?: string
}

const exited = (child: ChildProcess, ms: number): Promise<boolean> =>
  child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve(true)
    : new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), ms)
        child.once('exit', () => {
          clearTimeout(timer)
          resolve(true)
        })
      })

const signal = (pid: number, name: NodeJS.Signals): void => {
  try {
    process.kill(pid, name)
  } catch {
    // Already gone.
  }
}

export async function startLiveCore(options: StartLiveCoreOptions): Promise<LiveCore> {
  const daemonArgs = ['daemon', '--data-folder', options.dataFolder, '--control-port', '0']
  // The test hook that swaps the machine for a folder must never reach a live run.
  const inherited = { ...process.env }
  delete inherited['ATOMIC_MANAGED_TEST_HOST']
  const child =
    options.freshLoginAs === undefined
      ? spawn(options.bin, daemonArgs, {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...inherited, ...options.env },
        })
      : spawn(
          'sudo',
          [
            '-n',
            '-u',
            options.freshLoginAs,
            '-H',
            '--',
            '/usr/bin/env',
            ...Object.entries(options.env).map(([name, value]) => `${name}=${value}`),
            options.bin,
            ...daemonArgs,
          ],
          { stdio: ['ignore', 'pipe', 'pipe'], env: inherited }
        )
  let stdout = ''
  const log = (chunk: Buffer): void =>
    appendFileSync(
      options.logFile,
      chunk
        .toString()
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => `[core ${options.label}] ${line.replace(/\r$/, '')}\n`)
        .join('')
    )
  child.stderr?.on('data', log)
  const ready = await new Promise<ReadyLine>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no ready line from the ${options.label} core in 60 s`)),
      60_000
    )
    child.stdout?.on('data', (chunk: Buffer) => {
      log(chunk)
      stdout += chunk.toString()
      // Under `sudo` with `use_pty` (the default since sudo 1.9.14) lines end in \r\n.
      for (const line of stdout.split('\n').map((l) => l.replace(/\r$/, '').trim())) {
        if (!line.startsWith('{')) continue
        try {
          const parsed = JSON.parse(line) as ReadyLine
          if (typeof parsed.control_port === 'number') {
            clearTimeout(timer)
            resolve(parsed)
            return
          }
        } catch {
          // Not the ready line.
        }
      }
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(
        new Error(`the ${options.label} core exited with ${code} before it was ready; see ${options.logFile}`)
      )
    })
  })
  const api = new ControlApi(options.dataFolder, ready)
  return {
    label: options.label,
    ready,
    api,
    child,
    stop: async () => {
      await api.post('/shutdown', { force: true }, 10_000).catch(() => undefined)
      if (await exited(child, 60_000)) return
      // `ready.pid` is the core itself; under `sudo` the child is sudo, which exits with it.
      signal(ready.pid, 'SIGTERM')
      if (await exited(child, 30_000)) return
      signal(ready.pid, 'SIGKILL')
      child.kill('SIGKILL')
      await exited(child, 10_000)
    },
  }
}

export interface OperationView {
  operation_id: string
  revision: number
  phase: string
  plan_digest: string | null
  approved_plan_digest: string | null
  carried_plan_digest: string | null
  progress: { label: string; completed: number | null; total: number | null; unit: string } | null
  pending_host_step: PendingHostStep | null
  error: { code: string; message: string; details?: string } | null
}

export interface PendingHostStep {
  step_id: string
  action: string
  recipe_id: string
  recipe_digest: string
  parameters_digest: string
  parameters: {
    user: string
    arch: string
    family: string
    distro_id: string
    version_id: string
    components: string[]
  }
  nonce: string
  expected_operation_revision: number
}

/**
 * Reads the operation until `done`, or throws with where it got stuck. Every view is also handed to
 * `observe`, so the phase log has a second source besides the event stream.
 */
export async function pollOperation(
  api: ControlApi,
  operationId: string,
  done: (operation: OperationView) => boolean,
  timeoutMs: number,
  observe?: (operation: OperationView) => void
): Promise<OperationView> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const answer = await api.get<OperationView>(`/environments/operations/${operationId}`)
    if (answer.status !== 200) throw new Error(`GET operation answered ${answer.status}: ${answer.text}`)
    observe?.(answer.body)
    if (done(answer.body)) return answer.body
    if (Date.now() > deadline)
      throw new Error(
        `operation ${operationId} stuck at ${answer.body.phase} after ${timeoutMs} ms: ${JSON.stringify(answer.body.error)}`
      )
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
}
