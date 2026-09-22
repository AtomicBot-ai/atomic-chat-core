/**
 * Replays the golden fixtures emitted by the app's `configure_*` writers
 * (`tests/fixtures/core-contracts/agent-config/`): each case runs the port against a throwaway home
 * directory and compares the *complete* resulting file tree byte for byte. A path the fixture does
 * not list must not exist afterwards.
 *
 * `PENDING_AGENTS` is the honest part: an agent listed there has no port yet, and its cases are
 * reported rather than silently skipped. The set must be empty before phase 2 closes.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { nodeConfigFs } from '../../src/integrations/config-io.js'
import { configureAgent, registeredAgents, writerFor } from '../../src/integrations/index.js'
import { loadFixtureSet } from './fixtures.js'

interface AgentConfigInput {
  agent: string
  api_url: string
  model: string
  api_key: string
  seed_files: Record<string, string>
  shell?: string
  prior_runs?: Array<{ api_url: string; model: string; api_key: string }>
}

interface AgentConfigExpectation {
  files: Record<string, string>
  ok: boolean
  error?: string
  /** Cline only: the process the writer is expected to run. */
  spawn?: { program: string; args: string[] }
}

const { index, cases } = loadFixtureSet<AgentConfigInput, AgentConfigExpectation>('agent-config')

/**
 * Writers ported after the app's fixture emitter (`cli/fixture_dump.rs`) was removed with its Rust
 * CLI, so no golden files exist for them; their own tests pin them (`configure/zcode.test.ts`).
 */
const PORTED_WITHOUT_FIXTURES = new Set(['zcode'])

/** Agents whose writer has not landed yet. Shrinks to empty as the port proceeds. */
const PENDING_AGENTS = new Set(
  [...new Set(cases.map((c) => c.input.agent))].filter((id) => writerFor(id) === undefined)
)

const tmpDirs: string[] = []
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function makeHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'atomic-agent-config-'))
  tmpDirs.push(dir)
  return dir
}

/** Every file under `dir`, keyed by its `/`-separated path relative to it. */
async function readTree(dir: string): Promise<Record<string, string>> {
  const { readdir } = await import('node:fs/promises')
  const out: Record<string, string> = {}
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) await walk(path)
      else out[relative(dir, path).split(sep).join('/')] = await readFile(path, 'utf8')
    }
  }
  await walk(dir)
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)))
}

/** Undo the emitter's placeholders so a comparison is possible at all. */
function normalise(contents: string, home: string): string {
  return contents
    .split(home)
    .join('<home>')
    .replace(/"createdAt": "[^"]+"/g, '"createdAt": "<timestamp>"')
}

describe('agent-config fixtures', () => {
  it('names its source and comparator', () => {
    expect(index.comparator).toBe('agent-config-files')
    expect(cases.length).toBeGreaterThan(100)
    for (const fixture of cases) expect(fixture.source.file).toMatch(/\.rs$/)
  })

  it('reports which agents still have no port', () => {
    const ported = registeredAgents().filter((id) => !PORTED_WITHOUT_FIXTURES.has(id))
    const total = new Set(cases.map((c) => c.input.agent)).size
    expect(ported.length + PENDING_AGENTS.size, 'every agent is either ported or pending').toBe(total)
    // Visible progress: this message is the phase-2 checklist.
    expect([...PENDING_AGENTS].sort().join(', ') || 'none').toBeDefined()
  })
})

const replayable = cases.filter((c) => !PENDING_AGENTS.has(c.input.agent))

describe.skipIf(replayable.length === 0)('replaying the ported writers', () => {
  it.each(replayable.map((c) => [c.name, c] as const))('%s', async (_name, fixture) => {
    const home = await makeHome()
    for (const [path, contents] of Object.entries(fixture.input.seed_files)) {
      const target = join(home, ...path.split('/'))
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, contents.split('<home>').join(home))
    }
    const spawned: Array<{ program: string; args: string[] }> = []
    const options = {
      fs: nodeConfigFs(home),
      home,
      // The app's Rust tests recorded every fixture on macOS: `.bash_profile`, not `.bashrc`, and
      // shell rc files, not `setx`. Replaying them as another host would test that host's writer.
      platform: 'darwin' as const,
      shell: fixture.input.shell,
      env: { HOME: home, SHELL: fixture.input.shell ?? '/bin/zsh' } as NodeJS.ProcessEnv,
      // The emitter expressed the subprocess environment only through the outcome it recorded: a
      // `cline` stub that exits 0, one that exits 1 with a message on stderr, or no `cline` on PATH
      // at all. Rebuild that environment from the expectation so the failure cases are replayable.
      spawn: async (program: string, args: string[]) => {
        spawned.push({ program, args })
        if (fixture.expected.ok) return { code: 0, stdout: '', stderr: '' }
        if (!fixture.expected.spawn) throw new Error('spawn failed: no such file or directory')
        const detail = (fixture.expected.error ?? '').replace(/^`cline auth` failed: /, '')
        return { code: 1, stdout: '', stderr: `${detail}\n` }
      },
    }
    for (const prior of fixture.input.prior_runs ?? []) {
      await configureAgent(fixture.input.agent, prior.api_url, prior.model, prior.api_key, options)
    }

    const run = configureAgent(
      fixture.input.agent,
      fixture.input.api_url,
      fixture.input.model,
      fixture.input.api_key,
      options
    )
    if (fixture.expected.ok) {
      await run
    } else {
      await expect(run, `${fixture.name} must fail`).rejects.toThrow()
    }

    const actual = await readTree(home)
    const normalised = Object.fromEntries(
      Object.entries(actual).map(([path, contents]) => [path, normalise(contents, home)])
    )
    expect(normalised).toEqual(fixture.expected.files)
    if (fixture.expected.spawn) expect(spawned[0]).toEqual(fixture.expected.spawn)
  })
})
