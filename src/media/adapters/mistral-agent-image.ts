/**
 * `mistral-agent-image`: Mistral has no image endpoint; its Agents expose an `image_generation` tool
 * (FLUX1.1 Ultra behind it). One image is one conversation:
 *
 * - `POST {base}/conversations` with `{model: model.id, inputs: <instruction + prompt>, tools:
 *   [{type: 'image_generation'}], store: false}` (base `https://api.mistral.ai/v1`);
 * - the answer's outputs carry `tool_file` chunks (`{file_id, file_name, file_type}`), found by
 *   walking the JSON so a reshuffled envelope still reads;
 * - `GET {base}/files/{file_id}/content` downloads the image (the provider's own origin, so with the key).
 *
 * No `tool_file` means the model answered in words instead (a refusal, a question): that is
 * `REMOTE_REJECTED` carrying what it said. `n` images are `n` conversations.
 */

import {
  callProvider,
  downloadResult,
  GENERATE_TIMEOUT_MS,
  joinUrl,
  MAX_IMAGE_BYTES,
  remoteError,
  sniffImageMime,
} from '../http.js'
import type { MediaContext } from '../http.js'
import type { GeneratedImage, ImageAdapter, ImageGenerationJob } from './types.js'

type Fields = Record<string, unknown>

/** What the agent is told before the user's prompt. */
export const MISTRAL_IMAGE_INSTRUCTION =
  'Generate exactly one image with the image_generation tool. Do not ask questions and do not describe the ' +
  'image; call the tool once with this description:'

/** A file the image_generation tool made. */
export interface MistralToolFile {
  fileId: string
  fileName?: string
  fileType?: string
}

/** How deep the answer is walked; its chunks sit three or four levels down. */
const MAX_DEPTH = 8

/**
 * The `tool_file` chunks of a conversation answer, in order, and the text the model said, wherever
 * they sit (`outputs[].content[]` today).
 */
export function mistralToolFiles(json: unknown): { files: MistralToolFile[]; text: string } {
  const files: MistralToolFile[] = []
  const said: string[] = []
  const seen = new Set<string>()
  const visit = (value: unknown, depth: number): void => {
    if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1)
      return
    }
    const fields = value as Fields
    const type = fields['type']
    const fileId = fields['file_id']
    if (type === 'tool_file' && typeof fileId === 'string' && fileId !== '') {
      if (!seen.has(fileId)) {
        seen.add(fileId)
        const file: MistralToolFile = { fileId }
        if (typeof fields['file_name'] === 'string') file.fileName = fields['file_name']
        if (typeof fields['file_type'] === 'string') file.fileType = fields['file_type']
        files.push(file)
      }
      return
    }
    if (type === 'text' && typeof fields['text'] === 'string') said.push(fields['text'])
    else if (type === 'message.output' && typeof fields['content'] === 'string') said.push(fields['content'])
    for (const [key, item] of Object.entries(fields)) if (key !== 'usage') visit(item, depth + 1)
  }
  visit(json, 0)
  return { files, text: said.join(' ').replace(/\s+/g, ' ').trim() }
}

/** The conversation that makes one image. */
export function mistralConversation(job: ImageGenerationJob): Record<string, unknown> {
  return {
    model: job.model.id,
    inputs: `${MISTRAL_IMAGE_INSTRUCTION}\n\n${job.prompt}`,
    tools: [{ type: 'image_generation' }],
    store: false,
  }
}

async function oneImage(ctx: MediaContext, job: ImageGenerationJob): Promise<GeneratedImage[]> {
  const answer = await callProvider(ctx, joinUrl(ctx.baseUrl, '/conversations'), {
    json: mistralConversation(job),
    timeoutMs: GENERATE_TIMEOUT_MS,
  })
  const { files, text } = mistralToolFiles(answer.json)
  if (files.length === 0)
    throw remoteError(
      'REMOTE_REJECTED',
      text ? `${ctx.provider}: ${text.slice(0, 300)}` : `${ctx.provider} answered without an image.`,
      text.slice(0, 1000) || undefined
    )
  const out: GeneratedImage[] = []
  // The tool makes one image per call; a second file is taken too rather than dropped.
  for (const file of files) {
    const url = joinUrl(ctx.baseUrl, `/files/${encodeURIComponent(file.fileId)}/content`)
    const { bytes } = await downloadResult(ctx, url, { maxBytes: MAX_IMAGE_BYTES, what: 'image' })
    const mime = sniffImageMime(bytes)
    if (!mime)
      throw remoteError(
        'REMOTE_UNAVAILABLE',
        `${ctx.provider} returned a file that is not an image.`,
        file.fileId
      )
    out.push({ bytes, mime })
  }
  return out
}

export const MISTRAL_AGENT_IMAGE: ImageAdapter = {
  dialect: 'mistral-agent-image',
  kind: 'image',

  async generate(ctx, job, report) {
    report({ phase: 'generating' })
    if (job.workflow !== 'create')
      throw remoteError(
        'REMOTE_UNSUPPORTED',
        'This model only creates images from a prompt here.',
        job.workflow
      )
    const count = Math.max(1, job.n)
    const out: GeneratedImage[] = []
    while (out.length < count) {
      out.push(...(await oneImage(ctx, job)))
      if (count > 1) report({ phase: 'generating', fraction: Math.min(out.length / count, 1) })
    }
    return out.slice(0, count)
  },
}
