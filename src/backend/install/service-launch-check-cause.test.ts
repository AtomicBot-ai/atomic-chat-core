import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { c as tarCreate } from 'tar'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { makeTmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import { classifyFailure } from '../../telemetry/diagnostics.js'
import { BackendService } from './service.js'

let data: TmpDataFolder
beforeEach(async () => {
  data = await makeTmpDataFolder('atomic-core-launch-check-cause-')
})
afterEach(() => data.cleanup())

/**
 * A pack that fails its launch check is refused and the current build stays; the refusal is reported
 * once. The report must still carry what the check saw, or every such install renders as the
 * synthesized `backend install: unknown`.
 */
it('keeps the launch-check failure that refused the install reachable for classification', async () => {
  const fixture = join(data.root, 'fixture')
  await mkdir(join(fixture, 'build', 'bin'), { recursive: true })
  await writeFile(join(fixture, 'build', 'bin', 'llama-server'), '#!/bin/sh\nexit 0\n')
  const native = Object.assign(new Error('spawn llama-server EACCES'), {
    code: 'EACCES',
    syscall: 'spawn',
  })
  const reported: unknown[] = []
  const install = new BackendService({
    layout: data.layout,
    provider: 'llamacpp-upstream',
    downloader: {
      download: async (_task: string, items: Array<{ save_path: string }>) => {
        for (const item of items)
          await tarCreate({ gzip: true, cwd: fixture, file: item.save_path }, ['build'])
      },
    } as never,
    readManifest: async () => null,
    platform: 'darwin',
    now: () => 1,
    verifyMacBackend: async () => {
      throw native
    },
    onFailure: (error) => {
      reported.push(error)
    },
  })

  const refusal = await install
    .install('b6325', 'macos-arm64', { taskId: 'launch-check' })
    .catch((error: unknown) => error)

  expect(refusal).toBeInstanceOf(Error)
  expect((refusal as Error).message).toContain('failed its launch check')
  expect(reported).toHaveLength(1)
  expect((reported[0] as Error).cause).toBe(native)
  expect(classifyFailure(reported[0], { component: 'backend', operation: 'install' })).toMatchObject({
    component: 'backend',
    operation: 'install',
    category: 'operational',
    reason: 'disk_permission',
  })
})
