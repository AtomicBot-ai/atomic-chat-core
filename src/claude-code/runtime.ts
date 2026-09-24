import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { AtomicCoreError } from '../contracts/index.js'
import type {
  ClaudeCodeEvent,
  ClaudeCodeRequest,
  ClaudeCodeResult,
  ClaudeCodeStatus,
} from '../contracts/index.js'
import {
  cleanEnvironment,
  isSubscriptionAuth,
  modelSelector,
  parseCatalog,
  parseResult,
  validateRequest,
} from './policy.js'
import { findExecutable, runProcess } from './process.js'
import type { ClaudeProcessOptions } from './process.js'

export interface ClaudeCodeRuntimeOptions {
  cwd: string
  env?: NodeJS.ProcessEnv | undefined
  platform?: NodeJS.Platform | undefined
  home?: string | undefined
  executable?: string | undefined
  prefixArgs?: string[] | undefined
}

const textOnly = [
  '--tools',
  '',
  '--disallowedTools',
  'mcp__*',
  '--strict-mcp-config',
  '--mcp-config',
  '{"mcpServers":{}}',
  '--permission-mode',
  'dontAsk',
  '--no-chrome',
]

export class ClaudeCodeRuntime {
  private readonly options: ClaudeProcessOptions
  private readonly active = new Set<AbortController>()

  constructor(options: ClaudeCodeRuntimeOptions) {
    this.options = {
      ...options,
      env: cleanEnvironment(options.env ?? process.env),
      platform: options.platform ?? process.platform,
      home: options.home ?? homedir(),
    }
  }

  private async operation<T>(
    signal: AbortSignal | undefined,
    work: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    this.active.add(controller)
    try {
      return await work(controller.signal)
    } finally {
      signal?.removeEventListener('abort', abort)
      this.active.delete(controller)
    }
  }

  private async auth(signal: AbortSignal): Promise<Record<string, unknown>> {
    // Auth status can return exit 1 when logged out; ask the CLI for status in
    // status(), which handles that failure without inventing a connected state.
    const raw = await runProcess(this.options, ['auth', 'status'], {
      signal,
      timeoutMs: 15000,
      allowedExitCodes: [0, 1],
    })
    return JSON.parse(raw) as Record<string, unknown>
  }

  async status(signal?: AbortSignal): Promise<ClaudeCodeStatus> {
    return this.operation(signal, async (signal) => {
      const status: ClaudeCodeStatus = {
        installed: false,
        loggedIn: false,
        subscription: false,
        plan: null,
        version: null,
        error: null,
        models: [],
      }
      if (!(await findExecutable(this.options)))
        return {
          ...status,
          error: 'Install the official native Claude Code CLI, then check the connection again.',
        }
      status.installed = true
      try {
        const help = await runProcess(this.options, ['--help'], { signal, timeoutMs: 15000 })
        if (!help.includes('--safe-mode'))
          throw new Error('Update Claude Code: this connection requires --safe-mode support.')
        status.version = (await runProcess(this.options, ['--version'], { signal, timeoutMs: 15000 })).trim()
        const auth = await this.auth(signal)
        status.loggedIn = auth['loggedIn'] === true
        status.subscription = isSubscriptionAuth(auth)
        status.plan = typeof auth['subscriptionType'] === 'string' ? auth['subscriptionType'] : null
        if (status.subscription) {
          await runProcess(
            this.options,
            [
              '-p',
              '--input-format',
              'stream-json',
              '--output-format',
              'stream-json',
              '--verbose',
              '--no-session-persistence',
              ...textOnly,
            ],
            {
              signal,
              timeoutMs: 15000,
              keepInputOpen: true,
              input:
                JSON.stringify({
                  type: 'control_request',
                  request_id: 'atomic-model-catalog',
                  request: { subtype: 'initialize', hooks: null },
                }) + '\n',
              onLine: (line) => {
                const value = JSON.parse(line)
                if (
                  value.type === 'control_response' &&
                  value.response?.request_id === 'atomic-model-catalog'
                ) {
                  status.models = parseCatalog(value.response.response?.models)
                  return true
                }
              },
            }
          )
          if (!status.models.length)
            throw new Error('Claude Code returned no model catalog. Update Claude Code and try again.')
        }
      } catch (error) {
        signal.throwIfAborted()
        status.error = error instanceof Error ? error.message : String(error)
      }
      return status
    })
  }

  async login(signal?: AbortSignal): Promise<void> {
    await this.operation(signal, (signal) =>
      runProcess(this.options, ['auth', 'login'], { signal, timeoutMs: 180000, onLine: () => {} })
    )
  }

  async chat(
    input: ClaudeCodeRequest,
    emit: (event: ClaudeCodeEvent) => Promise<void>,
    signal?: AbortSignal
  ): Promise<ClaudeCodeResult> {
    const request = validateRequest(input)
    return this.operation(signal, async (signal) => {
      signal.throwIfAborted()
      await emit({ type: 'ready' })
      if (!isSubscriptionAuth(await this.auth(signal)))
        throw new AtomicCoreError(
          'AUTH_REQUIRED',
          'Sign in to your Claude subscription from Cloud → Claude subscription. API billing uses the separate Anthropic provider.'
        )
      const args = [
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
        '--include-partial-messages',
        ...textOnly,
      ]
      const model = modelSelector(request.model)
      if (model) args.push('--model', model)
      if (request.sessionId) args.push('--resume', request.sessionId)
      let systemDir: string | undefined
      let result: ClaudeCodeResult | undefined
      try {
        if (request.system) {
          // Avoid leaking system instructions through process arguments, and
          // avoid command-line size limits on Windows. No persistent new path.
          systemDir = await mkdtemp(join(tmpdir(), 'atomic-claude-system-'))
          const path = join(systemDir, 'prompt.txt')
          await writeFile(path, request.system, { mode: 0o600 })
          args.push('--system-prompt-file', path)
        }
        await runProcess(this.options, args, {
          signal,
          timeoutMs: 600000,
          input: request.prompt,
          onLine: async (line) => {
            const event = JSON.parse(line)
            if (
              event.type === 'stream_event' &&
              event.event?.delta?.type === 'text_delta' &&
              typeof event.event.delta.text === 'string'
            )
              await emit({ type: 'delta', text: event.event.delta.text })
            if (event.type === 'result') result = parseResult(event)
          },
        })
        if (!result)
          throw new AtomicCoreError('PROCESS_ERROR', 'Claude Code ended before completing the response.')
        return result
      } finally {
        if (systemDir) await rm(systemDir, { recursive: true, force: true })
      }
    })
  }

  shutdown(): void {
    for (const controller of this.active) controller.abort()
  }
}
