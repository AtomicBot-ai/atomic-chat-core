import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BPW, bonsaiLikeGguf } from '../../../test/helpers/gguf-builder.js'
import { makeTmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import { GgufParseError } from '../gguf/index.js'
import {
  hfResolveUrl,
  inspectLocalGguf,
  inspectRemoteGguf,
  REMOTE_GGUF_FIRST_BYTES,
  REMOTE_GGUF_MAX_BYTES,
} from './inspect.js'

let data: TmpDataFolder
beforeEach(async () => {
  data = await makeTmpDataFolder('atomic-inspect-')
})
afterEach(() => data.cleanup())

const FILE = bonsaiLikeGguf({
  weightType: 142,
  bitsPerWeight: BPW.pq2_0,
  metadata: { 'prism.hadamard.version': 1 },
})

describe('inspectLocalGguf', () => {
  it('reads the header of a file on disk', async () => {
    const path = join(data.root, 'm.gguf')
    await writeFile(path, FILE)
    const evidence = await inspectLocalGguf(path)
    expect(evidence.metadataKeys).toContain('prism.hadamard.version')
    expect(evidence.tensorTypes.find((t) => t.type === 142)?.bitsPerWeight).toBeCloseTo(BPW.pq2_0, 2)
    expect(await inspectLocalGguf(path)).toBe(evidence)
  })
  it('rejects a file that is not GGUF', async () => {
    const path = join(data.root, 'x.gguf')
    await writeFile(path, Buffer.alloc(64, 1))
    await expect(inspectLocalGguf(path)).rejects.toThrow(/Not a GGUF/)
  })
})

describe('hfResolveUrl', () => {
  it('pins the revision and encodes path segments', () => {
    expect(hfResolveUrl('prism-ml/Bonsai', 'dir/a b.gguf', 'abc')).toBe(
      'https://huggingface.co/prism-ml/Bonsai/resolve/abc/dir/a%20b.gguf'
    )
    expect(hfResolveUrl('o/r', 'f.gguf')).toBe('https://huggingface.co/o/r/resolve/main/f.gguf')
  })

  it('takes another endpoint', () => {
    expect(hfResolveUrl('o/r', 'f.gguf', 'main', 'http://127.0.0.1:9/hf/')).toBe(
      'http://127.0.0.1:9/hf/o/r/resolve/main/f.gguf'
    )
  })
})

describe('inspectRemoteGguf', () => {
  const rangeFetch = (status = 206, headers: Record<string, string> = {}) =>
    (async (_url: string, init?: RequestInit) => {
      const range = new Headers(init?.headers).get('range') ?? ''
      const end = Number(/bytes=0-(\d+)/.exec(range)?.[1] ?? FILE.length - 1)
      return new Response(FILE.subarray(0, end + 1), { status, headers })
    }) as typeof fetch

  it('reads the header over range requests, with the token', async () => {
    const seen: string[] = []
    const base = rangeFetch()
    const evidence = await inspectRemoteGguf('https://hf/x', {
      fetch: (async (u: string, init?: RequestInit) => {
        seen.push(new Headers(init?.headers).get('authorization') ?? '')
        return base(u, init)
      }) as typeof fetch,
      token: 't',
    })
    expect(evidence.tensorTypes.map((t) => t.type)).toContain(142)
    expect(seen[0]).toBe('Bearer t')
  })
  it('refuses a server that ignores Range for a large file', async () => {
    const whole = (async () =>
      new Response(FILE, { status: 200, headers: { 'content-length': String(10 ** 10) } })) as typeof fetch
    await expect(inspectRemoteGguf('https://hf/x', { fetch: whole })).rejects.toThrow(/range request/)
  })
  it('asks for 64 KiB first and doubles each time the tensor table needs more', async () => {
    const ranges: string[] = []
    const base = rangeFetch()
    await inspectRemoteGguf('https://hf/x', {
      fetch: (async (u: string, init?: RequestInit) => {
        ranges.push(new Headers(init?.headers).get('range') ?? '')
        return base(u, init)
      }) as typeof fetch,
    })
    expect(ranges[0]).toBe(`bytes=0-${REMOTE_GGUF_FIRST_BYTES - 1}`)
    const sizes = ranges.map((range) => Number(/bytes=0-(\d+)/.exec(range)?.[1]) + 1)
    for (let i = 1; i < sizes.length; i++) expect(sizes[i]).toBe((sizes[i - 1] as number) * 2)
    expect(REMOTE_GGUF_MAX_BYTES).toBe(64 * 1024 * 1024)
  })
  it('gives up with GgufParseError when the table does not fit the byte budget', async () => {
    await expect(
      inspectRemoteGguf('https://hf/x', { fetch: rangeFetch(), maxBytes: 128 })
    ).rejects.toBeInstanceOf(GgufParseError)
  })
  it('gives up after timeoutMs in all, saying so, when the mirror does not answer', async () => {
    const hanging = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      )) as typeof fetch
    await expect(inspectRemoteGguf('https://hf/x', { fetch: hanging, timeoutMs: 30 })).rejects.toThrow(
      'Reading the GGUF header of https://hf/x took longer than 0.03 seconds'
    )
  })
  it('waits for a slow mirror when no timeoutMs is given', async () => {
    const base = rangeFetch()
    const slow = (async (u: string, init?: RequestInit) => {
      await new Promise((resolve) => setTimeout(resolve, 60))
      expect(init?.signal?.aborted).toBe(false)
      return base(u, init)
    }) as typeof fetch
    expect((await inspectRemoteGguf('https://hf/x', { fetch: slow })).metadataKeys).toContain(
      'general.architecture'
    )
  })
  it('accepts a whole small file answered with 200', async () => {
    const small = (async () =>
      new Response(FILE, { status: 200, headers: { 'content-length': String(FILE.length) } })) as typeof fetch
    expect((await inspectRemoteGguf('https://hf/x', { fetch: small })).metadataKeys).toContain(
      'general.architecture'
    )
  })
})
