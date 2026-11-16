import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { BIN, control, startDaemon } from '../helpers/compiled-core.js'

it.skipIf(!existsSync(BIN))(
  'serializes Strata load against a replacement guard and keeps the guard after failed replacement',
  async () => {
    const data = await mkdtemp(join(tmpdir(), 'strata-maintenance-e2e-'))
    const daemons: ChildProcess[] = []
    try {
      const { ready } = await startDaemon(data, daemons)
      const post = (path: string, body: object) =>
        control(data, ready, path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      const guard = await post('/models/strata/maintenance', {
        request_id: 'replace',
        model_id: 'strata-model',
        action: 'replace',
        target_source_digest: 'a'.repeat(64),
      })
      expect(guard.status).toBe(200)
      const operation = (await guard.json()) as { operation_id: string }
      const [load, complete] = await Promise.all([
        post('/models/strata/strata-model/load', {}),
        post('/models/strata/maintenance/' + operation.operation_id + '/complete', {}),
      ])
      expect(await load.json()).toMatchObject({ error: { code: 'GPU_BUSY' } })
      expect(await complete.json()).toMatchObject({ error: { code: 'MODEL_INCOMPATIBLE' } })
      const recorded = await control(data, ready, '/models/strata/maintenance/' + operation.operation_id)
      expect(await recorded.json()).toMatchObject({ state: 'held', ready_to_mutate: true })
    } finally {
      for (const daemon of daemons) daemon.kill('SIGKILL')
      await rm(data, { recursive: true, force: true })
    }
  }
)
