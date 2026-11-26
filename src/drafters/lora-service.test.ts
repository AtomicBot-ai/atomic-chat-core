import { it, expect, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildGguf } from '../../test/helpers/gguf-builder.js'
import { Downloader } from '../downloads/index.js'
import { LoraService } from './lora-service.js'
import type { LoraArtifact } from './lora-catalog.js'
it('restores a failed reload, persists one binding per installation and clears it on removal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atomic-chat-lora-'))
  try {
    const bytes = buildGguf({ metadata: { 'general.type': 'adapter', 'adapter.type': 'lora' }, tensors: [] })
    const row: LoraArtifact = {
      mode: 'chat',
      repo: 'author/adapter',
      target: 'author/base',
      revision: 'b'.repeat(40),
      file: 'adapter.gguf',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.length,
    }
    const catalog = {
      files: [row],
      families: new Map<string, string>(),
      familyRepos: new Map<string, string>(),
      sources: new Map([['quant/base-gguf', row.target]]),
    }
    const fetcher = vi.fn(
      async () => new Response(new Uint8Array(bytes), { headers: { 'content-length': String(bytes.length) } })
    )
    const downloader = new Downloader({
      dataFolder: root,
      platform: 'darwin',
      fetch: fetcher,
      sleep: async () => {},
      emit: () => {},
    })
    const restart = vi.fn(async (_model: string, _rollback: () => Promise<void>) => {})
    const service = () =>
      new LoraService(
        root,
        downloader,
        fetcher,
        catalog,
        async (model) => ({ target: model === 'B' ? 'other/base' : row.target, signature: model }),
        restart,
        async () => catalog,
        async () => undefined
      )
    const first = service()
    expect(await first.search('', undefined, false, 'Quant/Base-GGUF')).toMatchObject({
      target: row.target,
      results: [row],
    })
    expect(await first.search('', undefined, false, 'other/model')).toMatchObject({
      target: 'other/model',
      results: [],
    })
    await first.install(row.sha256)
    expect(await first.choices('chat', 'A')).toMatchObject({ adapterId: null, files: [row] })
    await expect(first.select('chat', 'B', row.sha256)).rejects.toThrow('installed adapter')
    restart.mockRejectedValueOnce(new Error('load failed'))
    await expect(first.select('chat', 'A', row.sha256)).rejects.toThrow('load failed')
    expect(await service().resolve('chat', 'A')).toBeUndefined()
    await first.select('chat', 'A', row.sha256)
    const path = await service().resolve('chat', 'A')
    expect(path).toBeTruthy()
    await writeFile(path!, Buffer.alloc(bytes.length))
    await expect(first.resolve('chat', 'A')).rejects.toThrow('corrupt')
    await first.remove(row.sha256)
    expect(await service().choices('chat', 'A')).toMatchObject({ adapterId: null, files: [] })
    fetcher.mockRejectedValue(new Error('offline'))
    await expect(first.install(row.sha256)).rejects.toThrow()
    expect((await first.list()).files).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
