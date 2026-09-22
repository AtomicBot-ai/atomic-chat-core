import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AtomicCoreError } from '../../contracts/index.js'
import { classifyProcessOutput } from '../llamacpp/index.js'
import type { SessionInfo } from '../../contracts/index.js'
import { hostPid, isProcessAlive, isReadyLogLine, spawnAndAwaitReady, spawnManaged } from './process.js'

const node = (script: string) => ({
  exe: process.execPath,
  args: ['-e', script],
  env: { ...process.env } as Record<string, string>,
})
const classify = (exit: Parameters<typeof classifyProcessOutput>[0], stderr: string, stdout: string) =>
  classifyProcessOutput(exit, stderr, stdout, process.platform)

describe('isReadyLogLine', () => {
  it.each([
    ['main: server is listening on http://127.0.0.1:8080', true],
    ['srv  listening on http://127.0.0.1:8080', true],
    ['all slots are idle', true],
    ['starting the main loop', true],
    ['http server listening', true],
    ['loading model', false],
  ])('%j → %s', (l, e) => expect(isReadyLogLine(l.toLowerCase())).toBe(e))
  it('honours custom markers', () => {
    expect(isReadyLogLine('uvicorn running on', ['uvicorn running on'])).toBe(true)
    expect(isReadyLogLine('listening on', ['uvicorn running on'])).toBe(false)
  })
})

describe('spawnAndAwaitReady', () => {
  it('reports ready from a log line and keeps the process running', async () => {
    const lines: string[] = []
    const r = await spawnAndAwaitReady(
      node(
        'console.log("loading"); console.error("main: server is listening on http://127.0.0.1:1"); setInterval(()=>{},1000)'
      ),
      { timeoutMs: 5000, classifyExit: classify, onLine: (_s, l) => lines.push(l) }
    )
    expect(r.readyVia).toBe('log')
    expect(r.process.pid).toBeGreaterThan(0)
    expect(isProcessAlive(r.process.pid)).toBe(true)
    expect(lines).toContain('loading')
    const exit = await r.process.terminate(2000)
    expect(exit.signal === 'SIGTERM' || exit.code !== null).toBe(true)
    expect(isProcessAlive(r.process.pid)).toBe(false)
  })

  it('reports ready from the health check when the log never says so', async () => {
    let calls = 0
    const r = await spawnAndAwaitReady(node('setInterval(()=>{},1000)'), {
      timeoutMs: 5000,
      healthCheck: async () => ++calls >= 2,
      healthIntervalMs: 10,
      classifyExit: classify,
    })
    expect(r.readyVia).toBe('health')
    expect(calls).toBeGreaterThanOrEqual(2)
    await r.process.terminate(500)
  })

  it('classifies an early failure through the caller (OOM on stderr, arch on stdout)', async () => {
    await expect(
      spawnAndAwaitReady(node('console.error("ggml: out of memory"); process.exit(1)'), {
        timeoutMs: 5000,
        classifyExit: classify,
      })
    ).rejects.toMatchObject({ code: 'OUT_OF_MEMORY' })
    await expect(
      spawnAndAwaitReady(node('console.log("unknown model architecture: q"); process.exit(1)'), {
        timeoutMs: 5000,
        classifyExit: classify,
      })
    ).rejects.toMatchObject({ code: 'MODEL_ARCH_NOT_SUPPORTED' })
  })

  it('treats a clean exit without a ready line as the generic error', async () => {
    await expect(
      spawnAndAwaitReady(node('console.error("bye"); process.exit(0)'), {
        timeoutMs: 5000,
        classifyExit: classify,
      })
    ).rejects.toMatchObject({
      code: 'LLAMA_CPP_PROCESS_ERROR',
      details: 'bye\n',
    })
  })

  it('times out, kills the child and reports MODEL_LOAD_TIMED_OUT with stderr in the details', async () => {
    const err = (await spawnAndAwaitReady(node('console.error("still loading"); setInterval(()=>{},1000)'), {
      timeoutMs: 300,
      classifyExit: classify,
    }).catch((e: unknown) => e)) as AtomicCoreError
    expect(err).toBeInstanceOf(AtomicCoreError)
    expect(err.code).toBe('MODEL_LOAD_TIMED_OUT')
    expect(err.details).toContain('still loading')
  })

  it('fails at a line that already means failure, before the process exits', async () => {
    const started = Date.now()
    await expect(
      spawnAndAwaitReady(node(`console.error('[x] ERROR: nope'); setTimeout(() => process.exit(1), 5000)`), {
        timeoutMs: 10_000,
        classifyExit: classify,
        failOnLine: (stream, line) =>
          stream === 'stderr' && line.includes('ERROR:')
            ? new AtomicCoreError('PROCESS_ERROR', line)
            : undefined,
      })
    ).rejects.toMatchObject({ code: 'PROCESS_ERROR', message: '[x] ERROR: nope' })
    expect(Date.now() - started).toBeLessThan(4000)
  })

  it('reads readiness per stream when a backend says ready differently on each', async () => {
    const markers = { stdout: ['server started'], stderr: ['uvicorn running on'] }
    // "uvicorn running on" on stdout is not a stdout marker, so only the stderr line counts.
    const { process: proc } = await spawnAndAwaitReady(
      node(
        `console.log('uvicorn running on 1'); setTimeout(() => console.error('Uvicorn running on 2'), 100); setInterval(() => {}, 1000)`
      ),
      { timeoutMs: 5000, classifyExit: classify, streamReadyMarkers: markers }
    )
    expect(proc.output().stderr).toContain('Uvicorn running on 2')
    await proc.terminate(0)
    await expect(
      spawnAndAwaitReady(node(`console.log('Uvicorn running on 1'); setInterval(() => {}, 1000)`), {
        timeoutMs: 300,
        classifyExit: classify,
        streamReadyMarkers: markers,
        timeoutGraceMs: 0,
        timeoutError: (stderr) => new AtomicCoreError('SERVER_START_TIMED_OUT', 'custom timeout', stderr),
      })
    ).rejects.toMatchObject({ code: 'SERVER_START_TIMED_OUT', message: 'custom timeout' })
  })

  it('surfaces a missing executable as IO_ERROR', async () => {
    await expect(
      spawnAndAwaitReady(
        { exe: '/definitely/not/here', args: [], env: {} },
        { timeoutMs: 1000, classifyExit: classify }
      )
    ).rejects.toMatchObject({ code: 'IO_ERROR' })
  })

  it('does not spawn for an already-aborted signal and terminates a startup aborted later', async () => {
    await expect(
      spawnAndAwaitReady(node('setInterval(()=>{},1000)'), {
        timeoutMs: 5000,
        signal: AbortSignal.abort(),
        classifyExit: classify,
      })
    ).rejects.toMatchObject({ code: 'CORE_NOT_RUNNING' })

    const dir = await mkdtemp(join(tmpdir(), 'atomic-process-abort-'))
    const pidFile = join(dir, 'pid')
    const controller = new AbortController()
    const pending = spawnAndAwaitReady(
      node(
        `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(()=>{},1000)`
      ),
      { timeoutMs: 5000, signal: controller.signal, classifyExit: classify }
    )
    let pid = 0
    const deadline = Date.now() + 2000
    while (!pid && Date.now() < deadline) {
      pid = Number(await readFile(pidFile, 'utf8').catch(() => '0'))
      if (!pid) await new Promise((resolve) => setTimeout(resolve, 10))
    }
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'CORE_NOT_RUNNING' })
    expect(pid).toBeGreaterThan(0)
    expect(isProcessAlive(pid)).toBe(false)
    await rm(dir, { recursive: true, force: true })
  })

  it('never spawns for a load that was already cancelled', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atomic-process-cancel-'))
    const pidFile = join(dir, 'pid')
    await expect(
      spawnAndAwaitReady(
        node(
          `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(()=>{},1000)`
        ),
        { timeoutMs: 5000, cancelSignal: AbortSignal.abort(), classifyExit: classify }
      )
    ).rejects.toMatchObject({ code: 'MODEL_LOAD_CANCELLED', message: 'The model load was cancelled.' })
    await new Promise((resolve) => setTimeout(resolve, 100))
    // The child would have written its pid on its first tick had it been started.
    await expect(readFile(pidFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await rm(dir, { recursive: true, force: true })
  })

  it.skipIf(process.platform === 'win32')(
    'kills a starting child at once when the user cancels, even one that ignores SIGTERM',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'atomic-process-cancel-'))
      const pidFile = join(dir, 'pid')
      const controller = new AbortController()
      const pending = spawnAndAwaitReady(
        node(
          `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(()=>{},1000)`
        ),
        // A shutdown-style abort would give this child a 1 s grace; a cancel gives it none.
        { timeoutMs: 30_000, cancelSignal: controller.signal, classifyExit: classify }
      )
      let pid = 0
      const deadline = Date.now() + 2000
      while (!pid && Date.now() < deadline) {
        pid = Number(await readFile(pidFile, 'utf8').catch(() => '0'))
        if (!pid) await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(pid).toBeGreaterThan(0)
      const cancelledAt = Date.now()
      controller.abort()
      await expect(pending).rejects.toMatchObject({ code: 'MODEL_LOAD_CANCELLED' })
      // The error is raised only after the exit is confirmed, and well inside any grace period.
      expect(Date.now() - cancelledAt).toBeLessThan(900)
      expect(isProcessAlive(pid)).toBe(false)
      await rm(dir, { recursive: true, force: true })
    }
  )

  it('keeps the owner-shutdown error when both signals are present and shutdown fires', async () => {
    const shutdown = new AbortController()
    const cancel = new AbortController()
    const pending = spawnAndAwaitReady(node('setInterval(()=>{},1000)'), {
      timeoutMs: 5000,
      signal: shutdown.signal,
      cancelSignal: cancel.signal,
      classifyExit: classify,
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    shutdown.abort()
    await expect(pending).rejects.toMatchObject({ code: 'CORE_NOT_RUNNING' })
  })

  it('spawnManaged collects output and resolves exited', async () => {
    const p = spawnManaged(
      node('process.stdout.write("a\\nb\\n"); process.stderr.write("c\\n"); process.exit(3)')
    )
    const exit = await p.exited
    expect(exit.code).toBe(3)
    await new Promise((r) => setTimeout(r, 20))
    expect(p.output()).toEqual({ stdout: 'a\nb\n', stderr: 'c\n' })
  })
})

describe('spawnManaged hooks', () => {
  // sd.cpp redraws its step bar in place: `\r<bar> 1/4 - 2.0s/it ESC[K`, a newline only after the last step.
  const redraws =
    'process.stdout.write("\\r|=>  | 1/4 - 2.0s/it\\x1b[K");' +
    'setTimeout(() => { process.stdout.write("\\r|==> | 2/4 - 2.0s/it\\x1b[K"); process.stderr.write("warn\\n") }, 150);' +
    'setTimeout(() => process.exit(0), 300)'

  it('hands over raw chunks as they arrive, so a redraw without a line end is seen at once', async () => {
    const seen: Array<{ stream: string; text: string; at: number }> = []
    const started = Date.now()
    const p = spawnManaged(node(redraws), undefined, {
      onData: (stream, chunk) =>
        seen.push({ stream, text: chunk.toString('utf8'), at: Date.now() - started }),
    })
    await p.exited
    await new Promise((r) => setTimeout(r, 20))
    const stdout = seen.filter((c) => c.stream === 'stdout')
    expect(stdout.map((c) => c.text).join('')).toBe(
      '\r|=>  | 1/4 - 2.0s/it\x1b[K\r|==> | 2/4 - 2.0s/it\x1b[K'
    )
    // The first redraw arrived on its own, before the second one was written.
    expect(stdout[0]?.text).toBe('\r|=>  | 1/4 - 2.0s/it\x1b[K')
    expect(seen.filter((c) => c.stream === 'stderr').map((c) => c.text)).toEqual(['warn\n'])
  })

  it('keeps line delivery and capture working next to the raw hook', async () => {
    const lines: string[] = []
    let bytes = 0
    const p = spawnManaged(
      node('process.stdout.write("a\\nb\\n"); process.exit(0)'),
      (_stream, line) => lines.push(line),
      { onData: (_stream, chunk) => (bytes += chunk.length) }
    )
    await p.exited
    await new Promise((r) => setTimeout(r, 20))
    expect(lines).toEqual(['a', 'b'])
    expect(bytes).toBe(4)
    expect(p.output().stdout).toBe('a\nb\n')
  })

  it('keeps nothing when capture is off, with or without a line reader', async () => {
    const lines: string[] = []
    const withLines = spawnManaged(
      node('process.stdout.write("a\\n"); process.stderr.write("b\\n"); process.exit(0)'),
      (_stream, line) => lines.push(line),
      { captureOutput: false }
    )
    await withLines.exited
    await new Promise((r) => setTimeout(r, 20))
    expect(lines.sort()).toEqual(['a', 'b'])
    expect(withLines.output()).toEqual({ stdout: '', stderr: '' })

    // No reader at all: the pipes are still drained, so a chatty child is never blocked on a full one.
    const silent = spawnManaged(
      node('process.stdout.write("x".repeat(1 << 20), () => process.exit(7))'),
      undefined,
      { captureOutput: false }
    )
    expect((await silent.exited).code).toBe(7)
    expect(silent.output()).toEqual({ stdout: '', stderr: '' })
  })
})

describe('hostPid', () => {
  const native: SessionInfo = {
    pid: 4242,
    port: 39_411,
    model_id: 'qwen3-4b',
    model_path: '/models/qwen3-4b.gguf',
    is_embedding: false,
    api_key: '',
  }

  it('hands back the process id of a session that really is a process here', () => {
    expect(hostPid(native)).toBe(4242)
    // A record written before managed runtimes existed carries no kind, and is native.
    expect(hostPid({ ...native, execution: 'native' })).toBe(4242)
  })

  it('refuses a container session instead of handing out a number that means nothing here', () => {
    // The pid inside a container belongs to another kernel's numbering. Killing it, journalling it
    // or probing it would address whatever else on this machine happens to hold that number.
    expect(() => hostPid({ ...native, pid: null, execution: 'container' })).toThrow(AtomicCoreError)
    expect(() => hostPid({ ...native, pid: 1, execution: 'container' })).toThrow(
      /does not run as a process on this machine/
    )
  })

  it('refuses a session with no process id whatever it claims to be', () => {
    expect(() => hostPid({ ...native, pid: null })).toThrow(AtomicCoreError)
  })

  it('names the session it refused, so the caller can tell which one it was', () => {
    try {
      hostPid({ ...native, pid: null, execution: 'container' })
      throw new Error('expected a throw')
    } catch (error) {
      expect((error as AtomicCoreError).details).toContain('qwen3-4b')
      expect((error as AtomicCoreError).code).toBe('MANAGED_IDENTITY_MISMATCH')
    }
  })
})
