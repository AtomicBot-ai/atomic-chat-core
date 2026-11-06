import { expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PreparationJournal } from './operation-journal.js'
it('refuses traversal and a corrupt published record rather than silently losing consent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'flm-journal-')),
    id = randomUUID()
  try {
    const j = new PreparationJournal(dir)
    await expect(j.read('../evil')).rejects.toMatchObject({ code: 'MANAGED_OPERATION_NOT_FOUND' })
    await writeFile(
      join(dir, id + '.json'),
      JSON.stringify({ version: 1, record: { operation: { operation_id: id } }, digest: 'wrong' })
    )
    await expect(j.all()).rejects.toMatchObject({ code: 'MANAGED_METADATA_INVALID' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
