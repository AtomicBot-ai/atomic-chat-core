/**
 * The fake `docker` keeps its container table in one JSON file that every call rewrites. Calls run
 * at once in the e2e suites (a probe beside a load), and a shared temporary file let two of them
 * publish JSON with garbage after it, which failed `sglang-check` on CI. Each call writes its own.
 */
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const FAKE = fileURLToPath(new URL('../helpers/fake-model-docker.mjs', import.meta.url))
let dir: string

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const docker = (state: string, ...args: string[]) =>
  new Promise<number | null>((resolve) => {
    const child = spawn(process.execPath, [FAKE, ...args], {
      env: { ...process.env, FAKE_DOCKER_STATE: state },
      stdio: 'ignore',
    })
    child.on('exit', resolve)
  })

describe('the fake docker state file', () => {
  it('stays readable JSON while many calls write it at once', async () => {
    dir = await mkdtemp(join(tmpdir(), 'atomic-core-fake-docker-'))
    const state = join(dir, 'docker.json')
    // A table big enough that one write is several system calls, as after a long e2e file.
    const calls = Array.from({ length: 40_000 }, (_, i) => `container inspect c${i}`)
    await writeFile(state, JSON.stringify({ n: 0, containers: {}, calls }))
    for (let round = 0; round < 3; round++) {
      await Promise.all(Array.from({ length: 12 }, () => docker(state, 'info')))
      const db = JSON.parse(await readFile(state, 'utf8')) as { calls: string[] }
      expect(db.calls.length).toBeGreaterThan(0)
    }
  }, 60_000)
})
