/**
 * The fit margin through the compiled binary: on Apple silicon a model loaded with fit on reaches
 * llama-server with a `--fit-target` that leaves llama.cpp half of RAM, sized from the Metal device
 * the backend itself lists; everywhere else, and whenever the user set a margin of their own,
 * llama.cpp gets exactly what the settings say.
 *
 * No imports from `src/`: the expected margin is worked out here from this machine's RAM and the
 * device line the fake backend prints. POSIX only: the fake backend is a shell script.
 */
import type { ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir, totalmem } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as core from '../helpers/compiled-core.js'
import type { ReadyLine } from '../helpers/compiled-core.js'

const { BIN } = core
const MiB = 2 ** 20
const APPLE_SILICON = process.platform === 'darwin' && process.arch === 'arm64'
// Metal lets the GPU use about three quarters of RAM (an M4 Pro with 24 GiB lists 18186 MiB on
// macOS 26). Sized from this machine's RAM, not one Mac's, so the margin core adds — Metal's free
// memory less half of RAM — clears the 1 GiB floor below which core leaves fit alone, on any Mac.
const METAL_FREE_MIB = Math.floor((totalmem() / MiB) * 0.75)
const METAL_DEVICE = `MTL0: Apple M4 Pro (${METAL_FREE_MIB + 1} MiB, ${METAL_FREE_MIB} MiB free);BLAS: Accelerate (0 MiB, 0 MiB free)`

let dataFolder: string
const daemons: ChildProcess[] = []

beforeEach(async () => {
  dataFolder = await mkdtemp(join(tmpdir(), 'atomic-core-e2e-fit-margin-'))
})
afterEach(async () => {
  for (const daemon of daemons.splice(0)) daemon.kill('SIGKILL')
  core.reapJournalledChildren(dataFolder)
  await rm(dataFolder, { recursive: true, force: true })
})

const control = (ready: ReadyLine, path: string, init: RequestInit = {}) =>
  core.control(dataFolder, ready, path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  })

/**
 * The fake model is 64 bytes and no GGUF, so all it needs is the 1 GiB compute reserve — under half
 * of any RAM this runs on — and llama.cpp is left with half of RAM out of what Metal lists as free.
 */
function expectedMarginMiB(): number {
  const ramMiB = Math.floor(totalmem() / MiB)
  return Math.floor(METAL_FREE_MIB - ramMiB / 2)
}

async function loadAndReadArgv(settings: Record<string, unknown>): Promise<string[]> {
  const argvFile = join(dataFolder, 'argv.jsonl')
  await core.writeModel(dataFolder, 'demo')
  await core.writeFakeBackend(dataFolder, {
    FAKE_LLAMA_ARGV_FILE: argvFile,
    FAKE_LLAMA_DEVICES: METAL_DEVICE,
  })
  const { ready } = await core.startDaemon(dataFolder, daemons)
  const patched = await control(ready, '/settings/llamacpp-upstream', {
    method: 'PATCH',
    body: JSON.stringify({ values: settings }),
  })
  expect(patched.status, await patched.clone().text()).toBe(200)
  const loaded = await control(ready, '/models/llamacpp-upstream/demo/load', { method: 'POST', body: '{}' })
  expect(loaded.status, await loaded.clone().text()).toBe(200)
  const [record] = readFileSync(argvFile, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { argv: string[] })
  return record?.argv ?? []
}

const flag = (argv: string[], name: string) => {
  const at = argv.indexOf(name)
  return at >= 0 ? argv[at + 1] : undefined
}

describe.skipIf(!existsSync(BIN) || process.platform === 'win32')('fit margin on unified memory', () => {
  it(
    APPLE_SILICON
      ? 'widens the margin on Apple silicon so llama.cpp keeps to half of RAM'
      : 'leaves the margin to llama.cpp where the GPU memory is its own',
    async () => {
      const argv = await loadAndReadArgv({ fit: true, fit_target: '1024' })
      expect(flag(argv, '--fit')).toBe('on')
      expect(flag(argv, '--ctx-size')).toBeUndefined()
      if (APPLE_SILICON) expect(flag(argv, '--fit-target')).toBe(String(expectedMarginMiB()))
      else expect(flag(argv, '--fit-target')).toBeUndefined()
    }
  )

  it('passes a margin the user set through untouched', async () => {
    const argv = await loadAndReadArgv({ fit: true, fit_target: '2048' })
    expect(flag(argv, '--fit-target')).toBe('2048')
  })

  it('adds no margin with fit off', async () => {
    const argv = await loadAndReadArgv({ fit: false })
    expect(flag(argv, '--fit')).toBe('off')
    expect(flag(argv, '--fit-target')).toBeUndefined()
  })
})
