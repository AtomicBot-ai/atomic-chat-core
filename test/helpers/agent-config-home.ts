/**
 * A throwaway home directory for the agent-config writers, plus the `ConfigureInput` they take.
 *
 * The writers only ever address paths relative to `ConfigFs.home`, so a unit test can point them at
 * a temp directory and then read back the *whole* tree — which is what proves a failing writer
 * wrote nothing, not merely that the file it was asked about is unchanged.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { nodeConfigFs } from '../../src/integrations/index.js'
import type { ConfigFs, ConfigureInput } from '../../src/integrations/index.js'

export interface AgentHome {
  /** Absolute path of the throwaway home. */
  path: string
  fs: ConfigFs
  /** Write a file relative to the home, creating parent directories. */
  seed: (relative: string, contents: string) => Promise<void>
  /** Every file under the home, keyed by its `/`-separated relative path. Directories are ignored. */
  tree: () => Promise<Record<string, string>>
  /** One file's contents, or `undefined` when it does not exist. */
  read: (relative: string) => Promise<string | undefined>
  /** Does this relative path exist as a directory? */
  hasDir: (relative: string) => Promise<boolean>
  cleanup: () => Promise<void>
}

/**
 * `prefix` lands in the directory name, so a test can ask for a home whose path contains a space or
 * a non-ASCII character and check the writer still addresses it correctly.
 */
export async function makeAgentHome(prefix = 'atomic-agent-config-'): Promise<AgentHome> {
  const path = await mkdtemp(join(tmpdir(), prefix))
  const abs = (rel: string) => join(path, ...rel.split('/'))

  const tree = async (): Promise<Record<string, string>> => {
    const out: Record<string, string> = {}
    const walk = async (current: string): Promise<void> => {
      for (const entry of await readdir(current, { withFileTypes: true })) {
        const child = join(current, entry.name)
        if (entry.isDirectory()) await walk(child)
        else out[relative(path, child).split(sep).join('/')] = await readFile(child, 'utf8')
      }
    }
    await walk(path)
    return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)))
  }

  return {
    path,
    fs: nodeConfigFs(path),
    seed: async (rel, contents) => {
      const target = abs(rel)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, contents, 'utf8')
    },
    tree,
    read: (rel) =>
      readFile(abs(rel), 'utf8').then(
        (t: string) => t,
        () => undefined
      ),
    hasDir: (rel) =>
      readdir(abs(rel)).then(
        () => true,
        () => false
      ),
    cleanup: () => rm(path, { recursive: true, force: true }),
  }
}

export interface AgentInputOverrides {
  apiUrl?: string | undefined
  model?: string | undefined
  apiKey?: string | undefined
  platform?: NodeJS.Platform | undefined
  /** `$SHELL`. Passing it explicitly as `undefined` is meaningful: it is the "no $SHELL" case. */
  shell?: string | undefined
  env?: NodeJS.ProcessEnv | undefined
  spawn?: ConfigureInput['spawn']
}

/** The input a writer takes, with the values the fixtures use as defaults. */
export function agentInput(fs: ConfigFs, over: AgentInputOverrides = {}): ConfigureInput {
  const input: ConfigureInput = {
    apiUrl: over.apiUrl ?? 'http://127.0.0.1:1337/v1',
    model: over.model ?? 'AtomicChat/Qwen3.5-9B-GGUF',
    apiKey: over.apiKey ?? 'sk-atomic-fixture-key',
    fs,
    platform: over.platform ?? 'darwin',
    shell: 'shell' in over ? over.shell : '/bin/zsh',
    env: over.env ?? {},
  }
  return over.spawn ? { ...input, spawn: over.spawn } : input
}
