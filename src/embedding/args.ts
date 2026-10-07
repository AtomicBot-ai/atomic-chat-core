/**
 * The embedding process's argv and environment. Pure.
 *
 * Built here, not through the chat `args.ts`: that builder serves chat sessions and the RAG embedding
 * session with the chat provider's settings (cache types, fit, MTP, a forced `--pooling mean`), none of
 * which this process wants. Stock llama.cpp:
 *
 *   llama-server -m <gguf> [--mmproj <file>] -a <id> -c <n> -b <n> -ub <n> --embedding
 *                [--pooling <p>] [--image-max-tokens <n>] [-t <n>] --host 127.0.0.1 --port <p> --no-webui
 *
 * `-b` and `-ub` equal the context: an encoder (gemma-embedding2, bert) has no KV cache to split an
 * input over batches, so one whole input, media tokens included, must fit one ubatch; llama.cpp also
 * caps an image at half the ubatch. The key travels in `LLAMA_API_KEY`, never in argv.
 */

/** The environment variable the server's auth middleware reads (as `--api-key`). */
export const EMBEDDING_API_KEY_ENV = 'LLAMA_API_KEY'

/** Loopback only: the public server forwards to it, nothing else should reach it. */
export const EMBEDDING_HOST = '127.0.0.1'

export interface EmbeddingLaunchSpec {
  modelPath: string
  /** `--mmproj`, for a model that reads images or audio. */
  mmprojPath?: string
  /** `-a`: the name API clients pass as `model`. */
  modelId: string
  /** `-c`, `-b` and `-ub`. */
  ctxSize: number
  /** `--pooling`; omitted = the GGUF's own. */
  pooling?: string
  /** `--image-max-tokens`; omitted = the engine's own. */
  imageMaxTokens?: number
  /** `-t`; omitted = llama.cpp's own default. */
  threads?: number
  port: number
}

export function buildEmbeddingArgs(spec: EmbeddingLaunchSpec): string[] {
  const argv = ['-m', spec.modelPath]
  if (spec.mmprojPath) argv.push('--mmproj', spec.mmprojPath)
  argv.push('-a', spec.modelId)
  const ctx = String(spec.ctxSize)
  argv.push('-c', ctx, '-b', ctx, '-ub', ctx)
  argv.push('--embedding')
  if (spec.pooling) argv.push('--pooling', spec.pooling)
  if (spec.mmprojPath && spec.imageMaxTokens !== undefined && spec.imageMaxTokens > 0)
    argv.push('--image-max-tokens', String(spec.imageMaxTokens))
  if (spec.threads !== undefined && spec.threads > 0) argv.push('-t', String(spec.threads))
  argv.push('--host', EMBEDDING_HOST, '--port', String(spec.port))
  argv.push('--no-webui')
  return argv
}

/** The variables the core adds to the inherited environment. */
export function embeddingEnv(apiKey: string): Record<string, string> {
  return { [EMBEDDING_API_KEY_ENV]: apiKey }
}

/** `-a` when the settings leave it empty: the file name without `.gguf`, as llama-server would answer. */
export function defaultEmbeddingModelId(modelPath: string): string {
  const name = modelPath.split(/[\\/]/).pop() ?? modelPath
  return name.replace(/\.gguf$/i, '') || 'embedding'
}
