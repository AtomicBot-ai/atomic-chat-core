import { describe, expect, it } from 'vitest'
import { STRIPPED_DOCKER_ENV_VARS, dockerChildEnv } from './env.js'

describe('dockerChildEnv', () => {
  it('removes DOCKER_HOST, DOCKER_CONTEXT and DOCKER_CONFIG', () => {
    const base = {
      DOCKER_HOST: 'ssh://elsewhere',
      DOCKER_CONTEXT: 'remote',
      DOCKER_CONFIG: '/tmp/x',
      PATH: '/bin',
    }
    const env = dockerChildEnv(base)
    expect(env.DOCKER_HOST).toBeUndefined()
    expect(env.DOCKER_CONTEXT).toBeUndefined()
    expect(env.DOCKER_CONFIG).toBeUndefined()
    expect(env.PATH).toBe('/bin')
  })

  it('leaves the base object untouched', () => {
    const base = { DOCKER_HOST: 'ssh://elsewhere' }
    dockerChildEnv(base)
    expect(base.DOCKER_HOST).toBe('ssh://elsewhere')
  })

  it('defaults to a copy of process.env with the same vars stripped', () => {
    const original = process.env.DOCKER_HOST
    process.env.DOCKER_HOST = 'ssh://should-be-stripped'
    try {
      expect(dockerChildEnv().DOCKER_HOST).toBeUndefined()
    } finally {
      if (original === undefined) delete process.env.DOCKER_HOST
      else process.env.DOCKER_HOST = original
    }
  })

  it('lists exactly the three stripped variable names', () => {
    expect([...STRIPPED_DOCKER_ENV_VARS].sort()).toEqual(['DOCKER_CONFIG', 'DOCKER_CONTEXT', 'DOCKER_HOST'])
  })
})
