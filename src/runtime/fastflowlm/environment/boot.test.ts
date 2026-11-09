import { expect, it } from 'vitest'
import { nodeProbeDeps } from '../../../hardware/index.js'
import { preparationBoot } from './boot.js'
it('accepts only a known host boot identity', async () => {
  const deps = nodeProbeDeps({ platform: 'linux' }),
    id = 'bdd41d90-891b-42e4-8629-9bfa088ae513'
  expect(await preparationBoot({ ...deps, fs: { ...deps.fs, readFile: async () => id + '\n' } })).toBe(id)
  expect(
    await preparationBoot({
      ...deps,
      platform: 'win32',
      run: async () => ({ code: 0, stdout: '639006188465559111', stderr: '' }),
    })
  ).toBe('639006188465559111')
  expect(await preparationBoot({ ...deps, fs: { ...deps.fs, readFile: async () => '' } })).toBeNull()
})
