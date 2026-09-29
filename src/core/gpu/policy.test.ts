import { describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../../contracts/index.js'
import { cardsOverlap, claimsGpu, gpuBusyError, gpuEvictions } from './policy.js'
import type { GpuOccupant, GpuRequest } from './policy.js'

const GPU0 = 'GPU-0'
const GPU1 = 'GPU-1'

const occupant = (over: Partial<GpuOccupant> & Pick<GpuOccupant, 'provider' | 'model_id'>): GpuOccupant => ({
  cards: 'all',
  auxiliary: false,
  state: 'ready',
  ...over,
})

const request = (over: Partial<GpuRequest> & Pick<GpuRequest, 'provider' | 'model_id'>): GpuRequest => ({
  cards: 'all',
  auxiliary: false,
  ...over,
})

const llamaChat = occupant({ provider: 'llamacpp-upstream', model_id: 'qwen3-4b' })
const forkChat = occupant({ provider: 'llamacpp', model_id: 'gemma-3' })
const llamaCpu = occupant({ provider: 'llamacpp-upstream', model_id: 'cpu-model', cards: [] })
const embedding = occupant({
  provider: 'llamacpp-upstream',
  model_id: 'sentence-transformer-mini',
  auxiliary: true,
})
const transcription = occupant({ provider: 'llamacpp-upstream', model_id: 'voxtral', auxiliary: true })
const mlxChat = occupant({ provider: 'mlx', model_id: 'mlx-qwen' })
const diffusion = occupant({ provider: 'diffusion', model_id: 'flux' })
const trtOn0 = occupant({ provider: 'tensorrt-llm', model_id: 'llama-3', cards: [GPU0] })
const trtOn1 = occupant({ provider: 'tensorrt-llm', model_id: 'qwen3', cards: [GPU1] })
const trtStuck = occupant({
  provider: 'tensorrt-llm',
  model_id: 'stuck',
  cards: [GPU0],
  state: 'stop-unconfirmed',
})

const ids = (list: GpuOccupant[]) => list.map((o) => `${o.provider}/${o.model_id}`)

describe('cardsOverlap', () => {
  it.each([
    ['all vs all', 'all', 'all', true],
    ['all vs one card', 'all', [GPU0], true],
    ['one card vs all', [GPU1], 'all', true],
    ['same card', [GPU0], [GPU0], true],
    ['different cards', [GPU0], [GPU1], false],
    ['one of several', [GPU0, GPU1], [GPU1], true],
    ['CPU-only vs all', [], 'all', false],
    ['all vs CPU-only', 'all', [], false],
    ['CPU-only vs CPU-only', [], [], false],
  ] as const)('%s → %s', (_name, a, b, expected) => {
    expect(cardsOverlap(a, b)).toBe(expected)
  })
})

describe('claimsGpu', () => {
  it.each([
    ['a GPU chat load', request({ provider: 'llamacpp', model_id: 'c' }), true],
    ['a load on one card', request({ provider: 'tensorrt-llm', model_id: 't', cards: [GPU0] }), true],
    ['a CPU-only load', request({ provider: 'llamacpp', model_id: 'c', cards: [] }), false],
    [
      'an embedding or transcription load',
      request({ provider: 'llamacpp', model_id: 'e', auxiliary: true }),
      false,
    ],
    [
      'a CPU-only load of a one-session provider (it still stops its other session)',
      request({ provider: 'x', model_id: 'y', cards: [], soleSessionOfProvider: true }),
      true,
    ],
    [
      'an auxiliary load, even of a one-session provider',
      request({ provider: 'x', model_id: 'y', auxiliary: true, soleSessionOfProvider: true }),
      false,
    ],
  ])('%s → %s', (_name, req, expected) => {
    expect(claimsGpu(req)).toBe(expected)
  })
})

describe('gpuEvictions: one resident model per card (spec gpu-residency)', () => {
  const everyone = [
    llamaChat,
    forkChat,
    llamaCpu,
    embedding,
    transcription,
    mlxChat,
    diffusion,
    trtOn0,
    trtOn1,
  ]

  it.each([
    [
      'llama.cpp GPU chat evicts every other provider on any card, never its own provider or helpers',
      request({ provider: 'llamacpp-upstream', model_id: 'new-chat' }),
      ['llamacpp/gemma-3', 'mlx/mlx-qwen', 'diffusion/flux', 'tensorrt-llm/llama-3', 'tensorrt-llm/qwen3'],
    ],
    [
      'the TurboQuant fork is a provider of its own: it evicts upstream chat too',
      request({ provider: 'llamacpp', model_id: 'fork-chat' }),
      [
        'llamacpp-upstream/qwen3-4b',
        'mlx/mlx-qwen',
        'diffusion/flux',
        'tensorrt-llm/llama-3',
        'tensorrt-llm/qwen3',
      ],
    ],
    [
      'tensorrt-llm on its card: whatever occupies every card, the other tensorrt-llm session anywhere',
      request({ provider: 'tensorrt-llm', model_id: 'new-trt', cards: [GPU0], soleSessionOfProvider: true }),
      [
        'llamacpp-upstream/qwen3-4b',
        'llamacpp/gemma-3',
        'mlx/mlx-qwen',
        'diffusion/flux',
        'tensorrt-llm/llama-3',
        'tensorrt-llm/qwen3',
      ],
    ],
    [
      'diffusion evicts chat of every provider',
      request({ provider: 'diffusion', model_id: 'sdxl' }),
      [
        'llamacpp-upstream/qwen3-4b',
        'llamacpp/gemma-3',
        'mlx/mlx-qwen',
        'tensorrt-llm/llama-3',
        'tensorrt-llm/qwen3',
      ],
    ],
    [
      'a CPU-only load evicts nothing',
      request({ provider: 'llamacpp-upstream', model_id: 'cpu', cards: [] }),
      [],
    ],
    [
      'an embedding load evicts nothing',
      request({ provider: 'llamacpp-upstream', model_id: 'emb', auxiliary: true }),
      [],
    ],
    [
      'a transcription load evicts nothing',
      request({ provider: 'llamacpp-upstream', model_id: 'voxtral', auxiliary: true }),
      [],
    ],
  ])('%s', (_name, req, expected) => {
    expect(ids(gpuEvictions(req, everyone))).toEqual(expected)
  })

  it('leaves a session on another card alone when neither side takes every card', () => {
    const req = request({ provider: 'mlx', model_id: 'x', cards: [GPU1] })
    expect(ids(gpuEvictions(req, [trtOn0]))).toEqual([])
    expect(ids(gpuEvictions(req, [trtOn1]))).toEqual(['tensorrt-llm/qwen3'])
  })

  it('never lists the model being loaded itself, even on another provider-wide sweep', () => {
    const req = request({
      provider: 'tensorrt-llm',
      model_id: 'llama-3',
      cards: [GPU0],
      soleSessionOfProvider: true,
    })
    expect(ids(gpuEvictions(req, [trtOn0, trtOn1]))).toEqual(['tensorrt-llm/qwen3'])
  })

  it('lists a session whose stop was never confirmed like any other: it still holds its card', () => {
    const req = request({ provider: 'llamacpp-upstream', model_id: 'chat' })
    expect(gpuEvictions(req, [trtStuck])).toEqual([trtStuck])
  })

  it('lists loading and stopping sessions too: they hold, or are about to hold, the card', () => {
    const loading = { ...trtOn0, state: 'loading' as const }
    const stopping = { ...mlxChat, state: 'stopping' as const }
    expect(gpuEvictions(request({ provider: 'llamacpp', model_id: 'c' }), [loading, stopping])).toEqual([
      loading,
      stopping,
    ])
  })

  it('keeps the caller’s own shape, so the wiring can act on what it gets back', () => {
    const tagged = { ...diffusion, evict: 'diffusion.unloadModel' }
    const [first] = gpuEvictions(request({ provider: 'mlx', model_id: 'm' }), [tagged])
    expect(first?.evict).toBe('diffusion.unloadModel')
  })
})

describe('gpuBusyError', () => {
  it('names the blocking session, its state and cards, and why it could not be stopped', () => {
    const error = gpuBusyError(trtStuck, 'docker stop timed out')
    expect(error).toBeInstanceOf(AtomicCoreError)
    expect(error.code).toBe('GPU_BUSY')
    expect(error.message).toBe(
      'tensorrt-llm/stuck still holds the GPU: its stop has not been confirmed, so nothing else loads there yet.'
    )
    expect(error.details).toBe(
      'holder=tensorrt-llm/stuck state=stop-unconfirmed cards=GPU-0 cause=docker stop timed out'
    )
  })

  it('reads cards held on every GPU as "all", and omits a cause it was not given', () => {
    expect(gpuBusyError(llamaChat).details).toBe('holder=llamacpp-upstream/qwen3-4b state=ready cards=all')
  })
})
