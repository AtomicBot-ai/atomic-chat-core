import { describe, expect, it } from 'vitest'
import { buildEmbeddingArgs, defaultEmbeddingModelId, embeddingEnv, EMBEDDING_API_KEY_ENV } from './args.js'

describe('buildEmbeddingArgs', () => {
  it('starts a text model with one batch for one whole input and the GGUF pooling', () => {
    expect(
      buildEmbeddingArgs({ modelPath: '/m/bge.gguf', modelId: 'bge-m3', ctxSize: 8192, port: 3100 })
    ).toEqual([
      '-m',
      '/m/bge.gguf',
      '-a',
      'bge-m3',
      '-c',
      '8192',
      '-b',
      '8192',
      '-ub',
      '8192',
      '--embedding',
      '--host',
      '127.0.0.1',
      '--port',
      '3100',
      '--no-webui',
    ])
  })

  it.each([
    [{ pooling: 'cls' }, ['--pooling cls'], []],
    [{ threads: 6 }, ['-t 6'], []],
    [{ threads: 0 }, [], ['-t']],
    // An image budget means nothing without a projector.
    [{ imageMaxTokens: 280 }, [], ['--image-max-tokens']],
    [
      { mmprojPath: '/m/mmproj.gguf', imageMaxTokens: 280 },
      ['--mmproj /m/mmproj.gguf', '--image-max-tokens 280'],
      [],
    ],
    [
      { mmprojPath: '/m/mmproj.gguf', imageMaxTokens: 0 },
      ['--mmproj /m/mmproj.gguf'],
      ['--image-max-tokens'],
    ],
  ] as const)('%j adds %j and leaves out %j', (extra, present, absent) => {
    const argv = buildEmbeddingArgs({
      modelPath: '/m/x.gguf',
      modelId: 'x',
      ctxSize: 2048,
      port: 1,
      ...extra,
    })
    const joined = argv.join(' ')
    for (const pair of present) expect(joined).toContain(pair)
    for (const flag of absent) expect(argv).not.toContain(flag)
  })

  it('never puts the key in argv', () => {
    expect(embeddingEnv('secret')).toEqual({ [EMBEDDING_API_KEY_ENV]: 'secret' })
    expect(buildEmbeddingArgs({ modelPath: '/m/x.gguf', modelId: 'x', ctxSize: 1, port: 1 })).not.toContain(
      'secret'
    )
  })
})

describe('defaultEmbeddingModelId', () => {
  it.each([
    ['/data/embedding/models/bge-m3/bge-m3-q8_0.gguf', 'bge-m3-q8_0'],
    ['C:\\models\\Nomic.GGUF', 'Nomic'],
    ['plain', 'plain'],
    ['/x/.gguf', 'embedding'],
  ])('%s → %s', (path, id) => expect(defaultEmbeddingModelId(path)).toBe(id))
})
