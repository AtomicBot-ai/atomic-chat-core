import { describe, it, expect, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { buildGguf } from '../../test/helpers/gguf-builder.js'
import { dataLayout } from '../config/index.js'
import { Downloader } from '../downloads/index.js'
import { ModelRegistry } from '../models/index.js'
import { DrafterService } from './service.js'
import type { Drafter } from './catalog.js'

describe('upstream DSpark installations', () => {
  it('downloads without enabling, persists per model, restores a failed switch and deletes the installed artifact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dspark-test-'))
    try {
      const registry = new ModelRegistry(dataLayout(root), 'llamacpp-upstream')
      const target = buildGguf({ metadata: { 'general.architecture': 'qwen3' }, tensors: [] })
      const draft = buildGguf({
        metadata: { 'general.architecture': 'dflash' },
        tensors: ['markov_w1.weight', 'markov_w2.weight'].map((name) => ({
          name,
          type: 0,
          dims: [2],
          bitsPerWeight: 32,
        })),
      })
      const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex')
      const row: Drafter = {
        target: 'Qwen/Qwen3-4B',
        repo: 'tests/DSpark',
        revision: 'a'.repeat(40),
        file: 'draft.gguf',
        quant: 'F32',
        size: draft.length,
        sha256: hash(draft),
        targetSha256: hash(target),
        targetSize: target.length,
      }
      const request = vi.fn(
        async () =>
          new Response(new Uint8Array(draft), { headers: { 'content-length': String(draft.length) } })
      )
      const downloader = new Downloader({
        dataFolder: root,
        platform: 'darwin',
        fetch: request,
        emit: () => {},
      })
      const restart = vi.fn(async (_id: string, _rollback: () => Promise<void>) => {})
      const service = () => new DrafterService(root, registry, downloader, request, [row], restart)
      for (const id of ['A', 'B']) {
        await writeFile(join(root, id + '.gguf'), target)
        await registry.write(id, { model_path: id + '.gguf', name: id, size_bytes: target.length })
      }
      const legacy = buildGguf({
        metadata: { 'general.architecture': 'qwen3', 'general.name': 'conversion' },
        tensors: [],
      })
      await writeFile(join(root, 'renamed.gguf'), legacy)
      await registry.write('legacy', {
        model_path: 'renamed.gguf',
        name: 'legacy',
        size_bytes: legacy.length,
      })
      const catalogAware = new DrafterService(
        root,
        registry,
        downloader,
        request,
        [row],
        restart,
        undefined,
        undefined,
        [{ size: legacy.length, sha256: hash(legacy), source: 'publisher/conversion', target: row.target }]
      )
      expect(await catalogAware.choices('legacy')).toMatchObject({
        target: row.target,
        source: 'publisher/conversion',
      })
      const first = service()
      await first.install(row.sha256)
      expect(await first.choices('A')).toMatchObject({ target: row.target, id: null, files: [row] })
      restart.mockRejectedValueOnce(new Error('engine too old'))
      await expect(first.select('A', row.sha256)).rejects.toThrow('engine too old')
      expect(await first.resolve('A')).toBeUndefined()
      await first.select('A', row.sha256)
      expect(await service().resolve('A')).toMatch(/\.gguf$/)
      expect(await first.resolve('B')).toBeUndefined()
      await first.select('A', null)
      expect((await first.list()).files).toEqual([row])
      await first.select('B', row.sha256)
      // The same head can ship in both the base repo and a derivative's tested bundle.
      const baked = 'publisher/baked'
      first.remember([{ ...row, repo: baked, target: baked }])
      const scoped = await first.search(baked, '', false)
      expect(scoped.results.map((d) => d.repo)).toEqual([baked])
      await registry.write('baked-model', {
        model_path: 'renamed.gguf',
        name: 'baked-model',
        source_repo: baked,
      })
      const linked = new DrafterService(
        root,
        registry,
        downloader,
        request,
        [],
        restart,
        undefined,
        new Map([[baked, baked]])
      )
      linked.remember(scoped.results)
      await linked.select('baked-model', row.sha256)
      expect(await service().resolve('baked-model')).toBeTruthy()
      await first.remove(row.sha256)
      expect(await service().resolve('B')).toBeUndefined()
      expect((await service().list()).files).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
