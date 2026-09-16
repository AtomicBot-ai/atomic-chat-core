/** Embeddings through a core-owned llama-server, preserving the extension's batching contract. */
import { AtomicCoreError } from '../contracts/index.js'
import type { LocalProviderId, SessionInfo } from '../contracts/index.js'

export interface EmbeddingResponse {
  model: string
  object: 'list'
  usage: { prompt_tokens: number; total_tokens: number }
  data: Array<{ embedding: number[]; index: number }>
}

interface BatchResponse {
  data?: Array<{ embedding: number[]; index: number }>
  usage?: { prompt_tokens?: number; total_tokens?: number }
}

export interface EmbedDeps {
  findSession: (provider: LocalProviderId, modelId: string) => SessionInfo | undefined
  load: (provider: LocalProviderId, modelId: string) => Promise<SessionInfo>
  unload: (provider: LocalProviderId, modelId: string) => Promise<unknown>
  fetch?: typeof fetch
}

export class EmbedService {
  constructor(private readonly deps: EmbedDeps) {}

  async embed(
    provider: LocalProviderId,
    modelId: string,
    input: string[],
    ubatchSize: number
  ): Promise<EmbeddingResponse> {
    if (!Array.isArray(input) || input.some((value) => typeof value !== 'string')) {
      throw new AtomicCoreError('INVALID_ARGUMENT', 'input must be an array of strings')
    }
    if (!Number.isSafeInteger(ubatchSize) || ubatchSize < 2) {
      throw new AtomicCoreError('INVALID_ARGUMENT', 'ubatch_size must be an integer of at least 2')
    }
    let session = this.deps.findSession(provider, modelId) ?? (await this.deps.load(provider, modelId))
    let reloadedForEmbedding = false
    const result: EmbeddingResponse = {
      model: session.model_id,
      object: 'list',
      usage: { prompt_tokens: 0, total_tokens: 0 },
      data: [],
    }
    for (const { batch, offset } of buildEmbedBatches(input, ubatchSize)) {
      let response = await this.request(session, batch)
      if (response.status === 501 && !reloadedForEmbedding) {
        reloadedForEmbedding = true
        await this.deps.unload(provider, modelId).catch(() => {})
        session = await this.deps.load(provider, modelId)
        response = await this.request(session, batch)
      }
      if (!response.ok) {
        const body = await response.text().catch(() => '')
        throw new AtomicCoreError('IO_ERROR', `Embedding request failed with HTTP ${response.status}`, body)
      }
      const body = (await response.json()) as BatchResponse
      result.usage.prompt_tokens += body.usage?.prompt_tokens ?? 0
      result.usage.total_tokens += body.usage?.total_tokens ?? 0
      for (const item of body.data ?? []) result.data.push({ ...item, index: item.index + offset })
    }
    result.model = session.model_id
    return result
  }

  private request(session: SessionInfo, input: string[]): Promise<Response> {
    return (this.deps.fetch ?? fetch)(`http://127.0.0.1:${session.port}/v1/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.api_key}` },
      body: JSON.stringify({ input, model: session.model_id, encoding_format: 'float' }),
    })
  }
}

/** Same 3-chars/token, 50% safety-margin packing the legacy extension uses. */
export function buildEmbedBatches(
  input: string[],
  ubatchSize: number
): Array<{ batch: string[]; offset: number }> {
  const limit = Math.floor(ubatchSize * 0.5)
  const batches: Array<{ batch: string[]; offset: number }> = []
  let batch: string[] = []
  let tokens = 0
  let offset = 0
  const flush = () => {
    if (batch.length === 0) return
    batches.push({ batch, offset })
    offset += batch.length
    batch = []
    tokens = 0
  }
  for (const text of input) {
    const estimated = Math.max(1, Math.ceil(text.length / 3))
    if (estimated > limit) {
      flush()
      batches.push({ batch: [text], offset })
      offset++
      continue
    }
    if (batch.length && tokens + estimated > limit) flush()
    batch.push(text)
    tokens += estimated
  }
  flush()
  return batches
}
