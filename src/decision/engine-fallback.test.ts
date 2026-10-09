import { describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../contracts/index.js'
import { MAX_ENGINE_ATTEMPTS, spawnOnFirstGoodEngine } from './engine-fallback.js'
import type { EngineFallbackOptions } from './engine-fallback.js'

/** A gate over `builds` that skips what was rejected, and a spawn that fails as `fails` says. */
function world(builds: string[], fails: (path: string) => AtomicCoreError | undefined, explicit = false) {
  const rejected: Array<[string, string]> = []
  const logged: string[] = []
  const options: EngineFallbackOptions<{ path: string }, string> = {
    label: 'embedding',
    resolve: async () => {
      const next = builds.find((path) => !rejected.some(([exe]) => exe === path))
      if (next === undefined)
        throw new AtomicCoreError(
          'EMBEDDING_ENGINE_UNSUPPORTED',
          'No installed llama.cpp build can run the embedding model.',
          rejected.map(([exe, why]) => `${exe}: refused at readiness: ${why}`).join('\n')
        )
      return { path: next }
    },
    onEngine: () => {},
    throwIfStopped: () => {},
    spawn: async ({ path }) => {
      const error = fails(path)
      if (error) throw error
      return `running ${path}`
    },
    unsupportedCode: 'EMBEDDING_ENGINE_UNSUPPORTED',
    explicit,
    reject: async (exe, why) => void rejected.push([exe, why]),
    log: (_level, msg) => void logged.push(msg),
  }
  return { options, rejected, logged }
}

const died = () =>
  new AtomicCoreError(
    'MODEL_LOAD_FAILED',
    'The embedding model exited with code 9 while loading.',
    'ROCm error'
  )
const refused = () => new AtomicCoreError('EMBEDDING_ENGINE_UNSUPPORTED', 'no embeddings', 'answered 501')

describe('spawnOnFirstGoodEngine', () => {
  it('hands a build that died while loading back to the gate and runs the next', async () => {
    const w = world(['hip', 'vulkan'], (path) => (path === 'hip' ? died() : undefined))
    expect(await spawnOnFirstGoodEngine(w.options)).toBe('running vulkan')
    expect(w.rejected).toEqual([['hip', 'The embedding model exited with code 9 while loading.']])
    expect(w.logged).toEqual([
      'embedding engine hip failed to start, trying the next: The embedding model exited with code 9 while loading.',
    ])
  })

  it('still skips a build readiness refused, with the reason it gave', async () => {
    const w = world(['dev', 'release'], (path) => (path === 'dev' ? refused() : undefined))
    expect(await spawnOnFirstGoodEngine(w.options)).toBe('running release')
    expect(w.rejected).toEqual([['dev', 'answered 501']])
  })

  it('fails with the crash, not "no build left", once every build died', async () => {
    const w = world(['hip', 'vulkan'], () => died())
    const error = (await spawnOnFirstGoodEngine(w.options).catch((e: unknown) => e)) as AtomicCoreError
    expect(error).toMatchObject({
      code: 'MODEL_LOAD_FAILED',
      message: 'The embedding model exited with code 9 while loading.',
    })
    expect(error.details).toBe(
      'hip: refused at readiness: The embedding model exited with code 9 while loading.\n' +
        'vulkan: refused at readiness: The embedding model exited with code 9 while loading.\n\n' +
        'ROCm error'
    )
  })

  it('reports "no build left" as before when only refusals ran out', async () => {
    const w = world(['dev'], () => refused())
    await expect(spawnOnFirstGoodEngine(w.options)).rejects.toMatchObject({
      code: 'EMBEDDING_ENGINE_UNSUPPORTED',
    })
  })

  it('ends the start at the first failure of an explicit engine, and at any other error', async () => {
    const explicit = world(['mine'], () => died(), true)
    await expect(spawnOnFirstGoodEngine(explicit.options)).rejects.toMatchObject({
      code: 'MODEL_LOAD_FAILED',
    })
    expect(explicit.rejected).toEqual([])

    const slow = world(
      ['hip', 'vulkan'],
      () => new AtomicCoreError('MODEL_LOAD_TIMED_OUT', 'not ready in time')
    )
    await expect(spawnOnFirstGoodEngine(slow.options)).rejects.toMatchObject({ code: 'MODEL_LOAD_TIMED_OUT' })
    expect(slow.rejected).toEqual([])
  })

  it('gives up after MAX_ENGINE_ATTEMPTS builds', async () => {
    const builds = Array.from({ length: MAX_ENGINE_ATTEMPTS + 2 }, (_, i) => `b${i}`)
    const w = world(builds, () => died())
    await expect(spawnOnFirstGoodEngine(w.options)).rejects.toMatchObject({ code: 'MODEL_LOAD_FAILED' })
    expect(w.rejected).toHaveLength(MAX_ENGINE_ATTEMPTS - 1)
  })
})
