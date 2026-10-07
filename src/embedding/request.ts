/**
 * What the public `/v1/embeddings` checks before it passes a body to the embedding process. Pure.
 *
 * The body goes on as the client sent it; these checks only refuse:
 *  - media by reference: llama-server fetches an `http(s)` URL itself (and a `file://` one with
 *    `--media-path`), so an API open to the LAN would fetch whatever a client names. Only inline media
 *    (`data:` URLs, bare base64) is passed;
 *  - media the running model cannot read: the engine answers a 500 for it, a client error is a 400;
 *  - a `dimensions` the model does not produce: the engine ignores the field, and a client that asked
 *    for 256 numbers would store 768 without knowing (the model's shorter Matryoshka lengths are the
 *    client's to cut, as the app's catalog says).
 */

import type { EmbeddingModality } from '../contracts/index.js'

export type EmbeddingRequestVerdict = { ok: true } | { ok: false; message: string; param?: string }

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** The modality a content part carries, by its `type`; `undefined` for text and for types the engine judges. */
const PART_MODALITY: Readonly<Record<string, EmbeddingModality>> = {
  image_url: 'image',
  input_audio: 'audio',
  input_video: 'video',
  video_url: 'video',
}

/** A reference rather than inline bytes: anything with a scheme other than `data:`. */
export function isMediaReference(value: string): boolean {
  const scheme = /^\s*([a-z][a-z0-9+.-]*):/i.exec(value)
  return scheme !== null && scheme[1]!.toLowerCase() !== 'data'
}

/** Every string a part names its media by: `image_url.url`, `input_audio.data`/`url`, and the like. */
function mediaValues(part: Record<string, unknown>, type: string): string[] {
  const holder = part[type]
  const values: string[] = []
  const take = (v: unknown) => {
    if (typeof v === 'string') values.push(v)
  }
  if (typeof holder === 'string') take(holder)
  if (isRecord(holder)) {
    take(holder['url'])
    take(holder['data'])
  }
  return values
}

function checkParts(
  parts: readonly unknown[],
  where: string,
  modalities: readonly EmbeddingModality[]
): EmbeddingRequestVerdict {
  for (const [i, part] of parts.entries()) {
    if (!isRecord(part) || typeof part['type'] !== 'string') continue
    const type = part['type']
    const modality = PART_MODALITY[type]
    if (modality === undefined) continue
    if (!modalities.includes(modality))
      return {
        ok: false,
        message: `The running embedding model does not read ${modality === 'image' ? 'images' : modality} (${where}.content[${i}].type is "${type}").`,
        param: `${where}.content[${i}]`,
      }
    if (mediaValues(part, type).some(isMediaReference))
      return {
        ok: false,
        message: `Media must be sent inline, as a data: URL or base64; links are not fetched (${where}.content[${i}]).`,
        param: `${where}.content[${i}]`,
      }
  }
  return { ok: true }
}

/** The verdict on a parsed request body for a running model of `dims` that reads `modalities`. */
export function checkEmbeddingRequest(
  body: unknown,
  modalities: readonly EmbeddingModality[],
  dims: number | null
): EmbeddingRequestVerdict {
  if (!isRecord(body)) return { ok: false, message: 'The request body must be a JSON object.' }
  const input = body['input']
  if (input === undefined) return { ok: false, message: "The request needs an 'input'.", param: 'input' }
  const dimensions = body['dimensions']
  if (dimensions !== undefined && dimensions !== null && dims !== null && dimensions !== dims)
    return {
      ok: false,
      message: `The model returns ${dims}-dimension vectors and cannot shorten them; drop 'dimensions' or ask for ${dims}, then cut the vectors yourself if the model supports it.`,
      param: 'dimensions',
    }
  const items = Array.isArray(input) ? input : [input]
  for (const [i, item] of items.entries()) {
    if (!isRecord(item)) continue
    const where = Array.isArray(input) ? `input[${i}]` : 'input'
    const content = item['content']
    if (Array.isArray(content)) {
      const verdict = checkParts(content, where, modalities)
      if (!verdict.ok) return verdict
    }
    // The legacy multimodal shape: bare base64 only, never a link.
    const data = item['multimodal_data']
    if (Array.isArray(data) && data.some((d) => typeof d === 'string' && isMediaReference(d)))
      return {
        ok: false,
        message: `Media must be sent inline, as base64; links are not fetched (${where}.multimodal_data).`,
        param: `${where}.multimodal_data`,
      }
  }
  return { ok: true }
}
