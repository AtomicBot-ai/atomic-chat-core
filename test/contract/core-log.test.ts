/**
 * Pins `core.log`'s on-disk format as a core -> app contract (docs/contracts.md, design D9 of the
 * `add-unified-logs` change). Unlike the other sets in `test/contract/`, the core is the source of
 * truth here: the app has not copied `test/fixtures/core-log/sample.log` into its own tests yet, and
 * when it does, it names this repo's commit as the source, the way `test/fixtures/webm/README.md`
 * records ffmpeg's version rather than a source commit for its own hand-produced fixture.
 *
 * The comparison writes through the real `openLogFile`/`formatLogLine` machinery against the real
 * filesystem -- never a hand-built string -- so a change to the format, intentional or not, shows up
 * as a byte-for-byte diff against the fixture instead of a test that quietly drifted along with it.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openLogFile } from '../../src/host/log-file.js'

const FIXTURE_PATH = fileURLToPath(new URL('../fixtures/core-log/sample.log', import.meta.url))
const STRICT_HEADER = /^\[\d{4}-\d{2}-\d{2}\]\[\d{2}:\d{2}:\d{2}\]\[[^\]]*\]\[(DEBUG|INFO|WARN|ERROR)\] /

describe('contract: core-log', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atomic-core-log-contract-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes the pinned sample.log fixture byte-for-byte', () => {
    // One fixed instant per `write` call, not one shared instant: the fixture is meant to look like a
    // real, time-ordered run (core start, a warning, a multi-line error, then engine output), and
    // `write` calls `now()` exactly once per entry.
    const instants = [
      '2026-09-28T12:00:00Z', // core start line
      '2026-09-28T12:00:05Z', // core warning (matches specs/core-log/spec.md's own example)
      '2026-09-28T12:00:10Z', // core error, three lines
      '2026-09-28T12:00:15Z', // engine stderr line
      '2026-09-28T12:00:20Z', // engine stdout line
    ].map((iso) => new Date(iso))
    const now = (): Date => {
      const next = instants.shift()
      if (!next) throw new Error('test wrote more entries than instants were queued for')
      return next
    }

    const log = openLogFile(dir, 'core', { now })
    log.write('core', 'INFO', 'atomic-chat-app-core 0.7.0 starting (pid 4242, darwin/arm64)')
    log.write('core', 'WARN', 'backend catalog is stale')
    log.write(
      'core',
      'ERROR',
      [
        'model load failed: qwen3-8b',
        '  cause: out of memory allocating KV cache',
        '  hint: reduce --ctx-size or use a smaller quant',
      ].join('\n')
    )
    log.write(
      'engine:llamacpp/qwen3-8b',
      'INFO',
      '[stderr] llama_model_loader: loaded meta data with 24 key-value pairs and 292 tensors from qwen3-8b.gguf'
    )
    log.write(
      'engine:llamacpp/qwen3-8b',
      'INFO',
      '[stdout] main: server is listening on http://127.0.0.1:8080 - starting the main loop'
    )
    log.close()

    const written = readFileSync(join(dir, 'core.log'), 'utf8')
    const fixture = readFileSync(FIXTURE_PATH, 'utf8')
    expect(written).toBe(fixture)
  })

  it('has one strict header per entry, with the multi-line entry contributing continuation lines that do not match it', () => {
    // Mirrors the header app's `src-tauri/src/core/logs/` will split records on (design D7): a line
    // that does not match this is a continuation of the previous entry, never a record of its own.
    const fixture = readFileSync(FIXTURE_PATH, 'utf8')
    const lines = fixture.split('\n').slice(0, -1) // drop the empty element after the final trailing \n
    expect(lines).toHaveLength(7) // 5 entries; the ERROR entry alone contributes 2 continuation lines
    expect(lines.filter((line) => STRICT_HEADER.test(line))).toHaveLength(5)
  })
})
