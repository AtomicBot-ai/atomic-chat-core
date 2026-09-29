/**
 * The evidence a managed-install live run leaves behind (task 2.18): one line per event on stdout
 * (prefixed, so it can be grepped out of vitest's output) and the same in `run.log`, plus a
 * `summary.json` that is rewritten after every scenario — a run that dies half way still leaves
 * what it proved so far. Both land in the run's output folder, which is what gets attached to the PR.
 *
 * No imports from `src/`: the live test drives the compiled binary only.
 */
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type ScenarioStatus = 'passed' | 'failed' | 'skipped' | 'not-run'

export interface ScenarioRecord {
  id: string
  title: string
  status: ScenarioStatus
  /** Why it was skipped, or the failure's message. */
  reason: string | null
  duration_ms: number | null
  /** What the scenario observed that a reviewer wants to see: counts, digests, step outcomes. */
  details: Record<string, unknown>
}

export interface PhaseRecord {
  /** Which core observed it: `first` (the session before relogin) or `relogin` (the fresh one). */
  core: string
  phase: string
  revision: number
  at: string
  /** Time from this phase's first sighting to the next phase's; null for the last one. */
  duration_ms: number | null
  progress: { completed: number | null; total: number | null; unit: string } | null
}

export class LiveReport {
  readonly startedAt = new Date()
  private readonly scenarios = new Map<string, ScenarioRecord>()
  private readonly phases: PhaseRecord[] = []
  private readonly sections: Record<string, unknown> = {}

  constructor(
    readonly outDir: string,
    scenarioTitles: ReadonlyArray<readonly [string, string]>
  ) {
    mkdirSync(outDir, { recursive: true })
    for (const [id, title] of scenarioTitles)
      this.scenarios.set(id, { id, title, status: 'not-run', reason: null, duration_ms: null, details: {} })
  }

  get summaryPath(): string {
    return join(this.outDir, 'summary.json')
  }

  /** One human-readable line, to stdout and `run.log`. */
  log(message: string): void {
    const line = `[managed-install ${new Date().toISOString()}] ${message}`
    console.log(line)
    appendFileSync(join(this.outDir, 'run.log'), `${line}\n`)
  }

  /** A top-level section of the summary (`host`, `core`, `descriptor`, `model`, ...). */
  section(name: string, value: unknown): void {
    this.sections[name] = value
    this.flush()
  }

  detail(id: string, key: string, value: unknown): void {
    const record = this.require(id)
    record.details[key] = value
    this.flush()
  }

  finish(id: string, status: ScenarioStatus, reason: string | null, durationMs: number | null): void {
    const record = this.require(id)
    record.status = status
    record.reason = reason
    record.duration_ms = durationMs
    this.log(
      `scenario ${id}: ${status.toUpperCase()}${reason ? ` — ${reason}` : ''}${
        durationMs === null ? '' : ` (${(durationMs / 1000).toFixed(1)} s)`
      }`
    )
    this.flush()
  }

  status(id: string): ScenarioStatus {
    return this.require(id).status
  }

  /** Records a phase transition the first time it is seen, and closes the previous one's duration. */
  phase(core: string, phase: string, revision: number, progress: PhaseRecord['progress']): void {
    const last = this.phases[this.phases.length - 1]
    if (last !== undefined && last.phase === phase && last.core === core) {
      last.progress = progress ?? last.progress
      return
    }
    const now = new Date()
    if (last !== undefined) last.duration_ms = now.getTime() - Date.parse(last.at)
    this.phases.push({ core, phase, revision, at: now.toISOString(), duration_ms: null, progress })
    this.log(`operation phase ${phase} (core ${core}, revision ${revision})`)
    this.flush()
  }

  phaseNames(): string[] {
    return this.phases.map((p) => p.phase)
  }

  flush(): void {
    const summary = {
      schema_version: 1,
      test: 'test/live/managed-install.test.ts',
      started_at: this.startedAt.toISOString(),
      updated_at: new Date().toISOString(),
      ...this.sections,
      phases: this.phases,
      scenarios: [...this.scenarios.values()],
      totals: {
        passed: this.count('passed'),
        failed: this.count('failed'),
        skipped: this.count('skipped'),
        not_run: this.count('not-run'),
      },
    }
    const tmp = `${this.summaryPath}.tmp`
    writeFileSync(tmp, `${JSON.stringify(summary, null, 2)}\n`)
    renameSync(tmp, this.summaryPath)
  }

  /** The table printed at the end of the run. */
  table(): string {
    const rows = [...this.scenarios.values()].map(
      (s) =>
        `  ${s.status.toUpperCase().padEnd(8)} ${s.id.padEnd(30)} ${
          s.duration_ms === null ? '' : `${(s.duration_ms / 1000).toFixed(1)} s`
        }${s.reason ? `  — ${s.reason}` : ''}`
    )
    const phases = this.phases.map(
      (p) =>
        `  ${p.phase.padEnd(24)} core=${p.core.padEnd(8)} ${
          p.duration_ms === null ? '' : `${(p.duration_ms / 1000).toFixed(1)} s`
        }`
    )
    return ['Scenarios:', ...rows, 'Operation phases:', ...phases, `Summary: ${this.summaryPath}`].join('\n')
  }

  private count(status: ScenarioStatus): number {
    return [...this.scenarios.values()].filter((s) => s.status === status).length
  }

  private require(id: string): ScenarioRecord {
    const record = this.scenarios.get(id)
    if (record === undefined) throw new Error(`unknown scenario ${id}`)
    return record
  }
}
