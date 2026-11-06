import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, vi } from 'vitest'
import { stageNpuPackages } from './linux-npu-packages.js'
import { linuxManifest } from '../../../test/helpers/flm-environment.js'
import { parseEnvironment } from '../../runtime/fastflowlm/environment/index.js'
import { type LinuxNpuRecipe, type LinuxNpuTarget } from './linux-amd-npu.js'

it('stops before a package download on a signing-key or InRelease failure', async () => {
  const recipe = parseEnvironment(linuxManifest(), 'linux').recipes[0] as LinuxNpuRecipe
  const t = { recipe } as LinuxNpuTarget
  const fetchKey = vi.fn(async () => new Response('wrong key'))
  const run = vi.fn(async () => {
    throw Error('Bad InRelease signature')
  })
  for (const ppa of [true, false]) {
    const stage = await mkdtemp(join(tmpdir(), 'amd-npu-'))
    try {
      if (!ppa) recipe.sources[0]!.url = 'https://archive.ubuntu.com/ubuntu/'
      await expect(stageNpuPackages(t, recipe.packages, stage, '10', run, fetchKey)).rejects.toThrow()
      expect(run.mock.calls).toHaveLength(ppa ? 0 : 1)
    } finally {
      await rm(stage, { force: true, recursive: true })
    }
  }
})
