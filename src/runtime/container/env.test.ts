import { existsSync, rmSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { STRIPPED_DOCKER_ENV_VARS, dockerChildEnv, ensureDockerConfigDir } from './env.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('dockerChildEnv', () => {
  it('removes DOCKER_HOST and DOCKER_CONTEXT', () => {
    const base = {
      DOCKER_HOST: 'ssh://elsewhere',
      DOCKER_CONTEXT: 'remote',
      DOCKER_CONFIG: '/home/user/.docker',
      PATH: '/bin',
    }
    const env = dockerChildEnv({ base, dockerConfigDir: '/atomic/docker-config' })
    expect(env.DOCKER_HOST).toBeUndefined()
    expect(env.DOCKER_CONTEXT).toBeUndefined()
    expect(env.PATH).toBe('/bin')
  })

  it('points DOCKER_CONFIG at the given directory rather than stripping it (review round 1, item 5 ruling)', () => {
    const env = dockerChildEnv({
      base: { DOCKER_CONFIG: '/home/user/.docker' },
      dockerConfigDir: '/atomic/docker-config',
    })
    expect(env.DOCKER_CONFIG).toBe('/atomic/docker-config')
  })

  it('leaves the base object untouched', () => {
    const base = { DOCKER_HOST: 'ssh://elsewhere' }
    dockerChildEnv({ base, dockerConfigDir: '/atomic/docker-config' })
    expect(base.DOCKER_HOST).toBe('ssh://elsewhere')
  })

  it('defaults base to a copy of process.env with DOCKER_HOST/DOCKER_CONTEXT stripped', () => {
    const original = process.env.DOCKER_HOST
    process.env.DOCKER_HOST = 'ssh://should-be-stripped'
    try {
      expect(dockerChildEnv({ dockerConfigDir: '/atomic/docker-config' }).DOCKER_HOST).toBeUndefined()
    } finally {
      if (original === undefined) delete process.env.DOCKER_HOST
      else process.env.DOCKER_HOST = original
    }
  })

  it('lists exactly the two stripped variable names (DOCKER_CONFIG is set, not stripped)', () => {
    expect([...STRIPPED_DOCKER_ENV_VARS].sort()).toEqual(['DOCKER_CONTEXT', 'DOCKER_HOST'])
  })
})

describe('ensureDockerConfigDir', () => {
  it('creates the directory (and any missing parents) if it does not exist', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'docker-config-test-'))
    dirs.push(parent)
    const nested = join(parent, 'a', 'b')
    expect(existsSync(nested)).toBe(false)
    await ensureDockerConfigDir(nested)
    expect(existsSync(nested)).toBe(true)
  })

  it('is idempotent: calling it again on an already-existing directory does not throw', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'docker-config-test-'))
    dirs.push(dir)
    await expect(ensureDockerConfigDir(dir)).resolves.toBeUndefined()
    await expect(ensureDockerConfigDir(dir)).resolves.toBeUndefined()
  })
})
