import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { AtomicCoreError } from '../../contracts/index.js'
import { StrataProcessJournal } from './strata-process-journal.js'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

it('reports a journal root that cannot be prepared as a coded core error', async () => {
  const base = await mkdtemp(join(tmpdir(), 'atomic-strata-journal-open-'))
  dirs.push(base)
  const core = join(base, 'core')
  await mkdir(core, { recursive: true })
  // A leftover link whose target is gone: the same shape an interrupted reinstall of the data
  // folder leaves on Windows, where the root preparation loses the filesystem error.
  const root = join(core, 'strata')
  await symlink(join(base, 'gone'), root)

  const failure: unknown = await StrataProcessJournal.open(root, 'strata-v1').catch((error: unknown) => error)

  expect(failure).toBeInstanceOf(AtomicCoreError)
  expect((failure as AtomicCoreError).code).toBe('IO_ERROR')
  expect((failure as AtomicCoreError & { cause?: unknown }).cause).toMatchObject({ code: 'ENOENT' })
})
