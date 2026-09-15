/**
 * Everything the CLI touches outside its own logic, in one injectable object: output streams, the
 * environment, the clock, HTTP, and "wait until someone stops us". Tests drive commands with a
 * recording implementation instead of spawning a process for every assertion.
 */

import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'

export interface CliIo {
  stdout: (text: string) => void
  stderr: (text: string) => void
  env: NodeJS.ProcessEnv
  cwd: string
  fetch: typeof fetch
  readFile: (path: string) => Promise<string | undefined>
  /** Select one option; commands inject this so unit tests never need a real terminal. */
  select: (prompt: string, options: string[]) => Promise<number>
  /**
   * Block until the process is asked to stop, then run `onStop`. The daemon uses this to stay up;
   * a test hands back a promise it resolves itself.
   */
  waitForShutdown: (onStop: () => Promise<void>) => Promise<void>
}

export interface SelectTerminal {
  interactive: boolean
  write: (text: string) => void
  question: (prompt: string) => Promise<string>
}

/** The prompt policy without process globals, so invalid/non-interactive selections are testable. */
export async function selectOption(
  prompt: string,
  options: string[],
  terminal: SelectTerminal
): Promise<number> {
  if (!terminal.interactive) throw new Error(`${prompt} requires an interactive terminal.`)
  terminal.write(`\n${prompt}\n`)
  options.forEach((option, index) => terminal.write(`  ${index + 1}. ${option}\n`))
  const answer = await terminal.question('Selection [1]: ')
  const index = answer.trim() === '' ? 0 : Number(answer) - 1
  if (!Number.isInteger(index) || index < 0 || index >= options.length) throw new Error('Invalid selection.')
  return index
}

export function nodeCliIo(): CliIo {
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    env: process.env,
    cwd: process.cwd(),
    fetch: (...args) => fetch(...args),
    readFile: (path) =>
      readFile(path, 'utf8').then(
        (t) => t,
        () => undefined
      ),
    select: (prompt, options) => {
      let readline: ReturnType<typeof createInterface> | undefined
      return selectOption(prompt, options, {
        interactive: Boolean(process.stdin.isTTY),
        write: (text) => process.stderr.write(text),
        question: async (text) => {
          readline = createInterface({ input: process.stdin, output: process.stderr })
          return readline.question(text)
        },
      }).finally(() => readline?.close())
    },
    waitForShutdown: (onStop) =>
      new Promise<void>((resolve) => {
        const stop = () => {
          process.off('SIGINT', stop)
          process.off('SIGTERM', stop)
          void onStop().finally(resolve)
        }
        process.on('SIGINT', stop)
        process.on('SIGTERM', stop)
        // A daemon whose stdin closes has no controlling client left in the foreground, but that is
        // not a reason to stop: ownership is explicit (PLAN.md §3.6). Only signals stop us.
      }),
  }
}

/** Collects output instead of writing it; the tests' view of a command run. */
export function recordingIo(over: Partial<CliIo> = {}): CliIo & { out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  return {
    out,
    err,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    env: {},
    cwd: process.cwd(),
    fetch: (...args) => fetch(...args),
    readFile: (path) =>
      readFile(path, 'utf8').then(
        (t) => t,
        () => undefined
      ),
    select: async () => 0,
    waitForShutdown: async (onStop) => {
      await onStop()
    },
    ...over,
  }
}
