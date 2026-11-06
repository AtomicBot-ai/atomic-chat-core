/**
 * The fake `docker` keeps its container table in one JSON file that every call rewrites. Calls run
 * at once in the e2e suites (a probe beside a load), and a shared temporary file let two of them
 * publish JSON with garbage after it, which failed `sglang-check` on CI. Each call writes its own.
 * The engines `docker start` runs detached end on their own once that file is gone, so a test run
 * that dies before its `afterEach` leaves none of them listening.
 */
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const FAKE = fileURLToPath(new URL('../helpers/fake-model-docker.mjs', import.meta.url))
let dir: string

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const dockerWithEnv = (state: string, env: NodeJS.ProcessEnv, ...args: string[]) =>
  new Promise<number | null>((resolve) => {
    const child = spawn(process.execPath, [FAKE, ...args], {
      env: { ...process.env, ...env, FAKE_DOCKER_STATE: state },
      stdio: 'ignore',
    })
    child.on('exit', resolve)
  })

const docker = (state: string, ...args: string[]) => dockerWithEnv(state, {}, ...args)

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

describe('a fake engine', () => {
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  it('ends on its own once the state file of the docker that started it is gone', async () => {
    dir = await mkdtemp(join(tmpdir(), 'atomic-core-fake-docker-'))
    const state = join(dir, 'docker.json')
    const model = `${join(dir, 'model')}:/atomic/model:ro`
    expect(
      await docker(state, 'create', '-p', '127.0.0.1:0:8000', '--gpus', 'all', '-v', model, 'image')
    ).toBe(0)
    expect(await docker(state, 'start', 'fakectr00000001')).toBe(0)
    const { pid } = (
      JSON.parse(await readFile(state, 'utf8')) as { containers: Record<string, { pid: number }> }
    ).containers.fakectr00000001 as { pid: number }
    expect(alive(pid)).toBe(true)

    await rm(dir, { recursive: true, force: true })
    const deadline = Date.now() + 10_000
    while (alive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
    expect(alive(pid)).toBe(false)
  }, 20_000)
})

describe('Docker-assigned host ports', () => {
  it.each([['trtllm-serve'], ['vllm', 'serve'], ['python3', '-m', 'sglang.launch_server']])(
    'binds an available port instead of guessing one for %s',
    async (...command) => {
      dir = await mkdtemp(join(tmpdir(), 'atomic-core-fake-docker-'))
      const holder = createServer((socket) => socket.destroy())
      await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', resolve))
      const taken = (holder.address() as AddressInfo).port
      const state = join(dir, 'docker.json')
      const preload = join(dir, 'fixed-random.mjs')
      // Reproduce the old fake's collision deterministically, regardless of other CI workers.
      await writeFile(preload, `Math.random = () => (${taken} - 30000 + 0.5) / 20000`)
      const env = { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` }
      const call = (...args: string[]) => dockerWithEnv(state, env, ...args)
      const id = 'fakectr00000001'
      try {
        expect(await call('create', '-p', '127.0.0.1::8000', '--gpus', 'all', 'image', ...command)).toBe(0)
        expect(await call('start', id)).toBe(0)
        const db = JSON.parse(await readFile(state, 'utf8')) as {
          containers: Record<string, { hostPort: number }>
        }
        const port = db.containers[id]!.hostPort
        expect(port).not.toBe(taken)
        expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200)
      } finally {
        await call('stop', id)
        await new Promise<void>((resolve) => holder.close(() => resolve()))
      }
    }
  )
})
