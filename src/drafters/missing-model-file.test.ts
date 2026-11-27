import { describe, it, expect, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { dataLayout } from '../config/index.js'
import { Downloader } from '../downloads/index.js'
import { ModelRegistry } from '../models/index.js'
import { AtomicCoreError } from '../contracts/index.js'
import { DrafterService } from './service.js'

describe('drafter requests for a model whose GGUF is gone', () => {
  it('reports a missing model file as MODEL_FILE_NOT_FOUND instead of a raw ENOENT', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dspark-gone-'))
    try {
      const registry = new ModelRegistry(dataLayout(root), 'llamacpp-upstream')
      // The model directory survives (model.yml is readable) but the GGUF it names is absent.
      await registry.write('ghost', { model_path: 'ghost.gguf', name: 'ghost', size_bytes: 1024 })
      const downloader = new Downloader({
        dataFolder: root,
        platform: 'linux',
        fetch: vi.fn(async () => new Response()),
        emit: () => {},
      })
      const service = new DrafterService(root, registry, downloader, fetch, [], async () => {})

      const fromChoices = await service.choices('ghost').catch((error: unknown) => error)
      expect(fromChoices).toBeInstanceOf(AtomicCoreError)
      expect((fromChoices as AtomicCoreError).code).toBe('MODEL_FILE_NOT_FOUND')

      const fromSelect = await service.select('ghost', null).catch((error: unknown) => error)
      expect(fromSelect).toBeInstanceOf(AtomicCoreError)
      expect((fromSelect as AtomicCoreError).code).toBe('MODEL_FILE_NOT_FOUND')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
