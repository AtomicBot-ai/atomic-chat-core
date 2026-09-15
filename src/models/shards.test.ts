import { describe, expect, it } from 'vitest'
import { firstGgufShardPath, ggufShardPath, ggufShardSetPaths, parseGgufShard } from './shards.js'

describe('shards', () => {
  it('recognises file-name and directory-name markers, last one wins', () => {
    expect(parseGgufShard('/m/Model-00002-of-00003.gguf')).toEqual({ index: 2, total: 3 })
    expect(parseGgufShard('/m/author/Model-00002-of-00003/model.gguf')).toEqual({ index: 2, total: 3 })
    expect(parseGgufShard('/m/Repo-00001-of-00002/Model-00003-of-00004.gguf')).toEqual({ index: 3, total: 4 })
    expect(parseGgufShard('/m/model.gguf')).toBeNull()
    expect(parseGgufShard('/m/Model-00000-of-00003.gguf')).toBeNull()
    expect(parseGgufShard('/m/Model-00004-of-00003.gguf')).toBeNull()
    expect(parseGgufShard('/m/Model-00001-of-00003.txt')).toBeNull()
  })
  it('rewrites the marker and enumerates the set', () => {
    expect(ggufShardPath('/m/Model-00002-of-00003.gguf', 1)).toBe('/m/Model-00001-of-00003.gguf')
    expect(ggufShardPath('/m/model.gguf', 1)).toBe('/m/model.gguf')
    expect(ggufShardSetPaths('/m/Model-00002-of-00003.gguf')).toEqual([
      '/m/Model-00001-of-00003.gguf',
      '/m/Model-00002-of-00003.gguf',
      '/m/Model-00003-of-00003.gguf',
    ])
    expect(ggufShardSetPaths('/m/model.gguf')).toEqual(['/m/model.gguf'])
    expect(firstGgufShardPath('/m/x/Model-00003-of-00003/model.gguf')).toBe(
      '/m/x/Model-00001-of-00003/model.gguf'
    )
  })
})
