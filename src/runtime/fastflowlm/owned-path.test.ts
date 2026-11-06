import { mkdtemp, mkdir, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it, expect } from 'vitest'
import { ownedFlmPath } from './owned-path.js'
it('refuses to create a runtime file through a directory redirected into the model store', async () => {
  const root = await mkdtemp(join(tmpdir(), 'flm-owner-'))
  try {
    await mkdir(join(root, 'models'))
    await symlink(join(root, 'models'), join(root, 'cache'), 'junction')
    await expect(ownedFlmPath(root, join(root, 'cache', 'new'))).rejects.toMatchObject({
      code: 'FASTFLOWLM_INVALID_INSTALLATION',
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
