/**
 * What the public `/v1/embeddings` checks before it passes a body to the embedding process. Pure.
 *
 * The body goes on as the client sent it; these checks only refuse:
 *  - media by reference: llama-server fetches an `http(s)` URL itself (and a `file://` one with
 *    `--media-path`), so an API open to the LAN would fetch whatever a client names. Only inline media
 *    (`data:` URLs, bare base64) is passed;
 *  - inline media the engine would fail to read for its form alone: no data, a `data:` URL it does not
 *    parse, a placeholder, base64 it stops reading early (its decoder ends at the first character outside
 *    the standard alphabet, so a line break or URL-safe base64 leaves a truncated file). The engine
 *    answers each of these with a 500; a client error is a 400 that names the field;
 *  - media the running model cannot read: the engine answers a 500 for it, a client error is a 400
 *    (for video, which also needs `ffmpeg` on this computer, the message says so);
 *  - a content part sent as an input of its own, outside `{content: [...]}`: llama.cpp refuses it
 *    with a message about prompt shapes, this one names the fix;
 *  - a `dimensions` the model does not produce: the engine ignores the field, and a client that asked
 *    for 256 numbers would store 768 without knowing (the model's shorter Matryoshka lengths are the
 *    client's to cut, as the app's catalog says).
 *
 * Bytes that pass all of this and still are no image, audio or video the engine decodes come back
 * from it as a 500; `undecodableMediaVerdict` turns that answer into the same kind of 400.
 */

import type { EmbeddingModality } from '../contracts/index.js'

export type EmbeddingRequestVerdict = { ok: true } | { ok: false; message: string; param?: string }

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** What a media part carries: every modality but text. */
type MediaModality = Exclude<EmbeddingModality, 'text'>

/** The modality a content part carries, by its `type`; `undefined` for text and for types the engine judges. */
const PART_MODALITY: Readonly<Record<string, MediaModality>> = {
  image_url: 'image',
  input_audio: 'audio',
  input_video: 'video',
  video_url: 'video',
}

/** Every content part type the engine reads, for spotting one sent outside `content`. */
const PART_TYPES: ReadonlySet<string> = new Set(['text', ...Object.keys(PART_MODALITY)])

/** A `data:` URL of the right kind, for the messages. */
const DATA_URL_EXAMPLE: Readonly<Record<MediaModality, string>> = {
  image: 'data:image/png;base64,<base64>',
  audio: 'data:audio/wav;base64,<base64>',
  video: 'data:video/mp4;base64,<base64>',
}

/** The `data:` URL media types llama-server reads (`handle_media`). */
const DATA_URL_TYPES = ['data:image/', 'data:audio/', 'data:video/']

/** A reference rather than inline bytes: anything with a scheme other than `data:`. */
export function isMediaReference(value: string): boolean {
  const scheme = /^\s*([a-z][a-z0-9+.-]*):/i.exec(value)
  return scheme !== null && scheme[1]!.toLowerCase() !== 'data'
}

/** One string the engine reads media from, and where in the body it is. */
type MediaField = {
  /** e.g. `input[0].content[1].image_url.url`. */
  path: string
  /** `''` when the part names none. */
  value: string
  modality: MediaModality
  /** `url`: a `data:` URL or bare base64 (a content part); `base64`: bare base64 only (`multimodal_data`). */
  form: 'url' | 'base64'
}

/**
 * The string llama-server reads a content part's media from: `image_url.url`; `data`, else `url`, of
 * `input_audio` and the video parts. A holder that is not an object, or a field that is not a string,
 * reads as `''`.
 */
function partField(part: Record<string, unknown>, type: string, at: string): MediaField {
  const holder = part[type]
  const fields = isRecord(holder) ? holder : {}
  const key =
    type === 'image_url' || (typeof fields['data'] !== 'string' && typeof fields['url'] === 'string')
      ? 'url'
      : 'data'
  const value = fields[key]
  return {
    path: `${at}.${type}.${key}`,
    value: typeof value === 'string' ? value : '',
    modality: PART_MODALITY[type]!,
    form: 'url',
  }
}

/** The bare base64 entries of the legacy multimodal shape, `{prompt_string, multimodal_data: [base64]}`. */
function multimodalFields(item: Record<string, unknown>, where: string): MediaField[] {
  const data = item['multimodal_data']
  if (!Array.isArray(data)) return []
  return data.flatMap((entry, k) =>
    typeof entry === 'string'
      ? [
          {
            path: `${where}.multimodal_data[${k}]`,
            value: entry,
            modality: 'image' as const,
            form: 'base64' as const,
          },
        ]
      : []
  )
}

/** Every string a part names its media by, read or not: a link in any of them is refused. */
function partReferences(part: Record<string, unknown>, type: string): string[] {
  const holder = part[type]
  if (typeof holder === 'string') return [holder]
  if (!isRecord(holder)) return []
  return [holder['url'], holder['data']].filter((v): v is string => typeof v === 'string')
}

/** Why bare base64 would not reach the engine whole, or `undefined` when it would. */
function base64Problem(data: string, path: string): string | undefined {
  if (data === '') return `${path} has no data: put the file's base64 there.`
  if (/\.\.\.|…|^<.*>$/.test(data))
    return `${path} holds a placeholder ("${data.length > 24 ? `${data.slice(0, 24)}…` : data}") where the file's base64 belongs: put the whole file there, base64-encoded.`
  const body = data.replace(/={1,2}$/, '')
  const bad = /[^A-Za-z0-9+/]/.exec(body)
  if (bad) {
    const at = `character ${bad.index + 1} of its base64`
    if (/\s/.test(bad[0]))
      return `${path} has a line break or space at ${at}, where the engine stops reading: send the base64 on one line.`
    if (bad[0] === '-' || bad[0] === '_')
      return `${path} is URL-safe base64 ('${bad[0]}' at ${at}): send standard base64, with + and /.`
    return `${path} is not base64: '${bad[0]}' at ${at}. Send the file's bytes base64-encoded (A–Z, a–z, 0–9, +, /).`
  }
  if (body.length % 4 === 1)
    return `${path} is cut short: its base64 ends partway through. Send the whole file.`
  return undefined
}

/** Why `field` would fail in the engine for its form alone, or `undefined`. */
function fieldProblem(field: MediaField): string | undefined {
  const { path, value, modality, form } = field
  if (form === 'base64') {
    if (/^\s*data:/i.test(value)) return `${path} takes bare base64, without the data: header.`
    return base64Problem(value, path)
  }
  if (value === '')
    return `${path} is missing: send the file inline, as a data: URL (${DATA_URL_EXAMPLE[modality]}) or bare base64.`
  if (!value.startsWith('data:')) {
    if (/^\s*data:/i.test(value))
      return `${path} must start with "data:" in lower case, with nothing before it.`
    return base64Problem(value, path)
  }
  const parts = value.split(',')
  if (parts.length !== 2)
    return `${path} must have one comma, between the header and the base64: ${DATA_URL_EXAMPLE[modality]}.`
  const [header, data] = parts as [string, string]
  if (!DATA_URL_TYPES.some((prefix) => header.startsWith(prefix)))
    return `${path} is a "${header.slice(0, 40)}" URL; the engine reads image/, audio/ and video/ ones: ${DATA_URL_EXAMPLE[modality]}.`
  if (!header.endsWith('base64')) return `${path} must be base64-encoded: ${DATA_URL_EXAMPLE[modality]}.`
  return base64Problem(data, path)
}

/** The items of `input`, each with where it is. */
function inputItems(input: unknown): Array<{ item: unknown; where: string }> {
  return Array.isArray(input)
    ? input.map((item, i) => ({ item, where: `input[${i}]` }))
    : [{ item: input, where: 'input' }]
}

/** Every media string of `body` the engine would read, in order. */
function mediaFields(body: unknown): MediaField[] {
  if (!isRecord(body)) return []
  const fields: MediaField[] = []
  for (const { item, where } of inputItems(body['input'])) {
    if (!isRecord(item)) continue
    const content = item['content']
    if (Array.isArray(content))
      for (const [i, part] of content.entries()) {
        if (!isRecord(part) || typeof part['type'] !== 'string') continue
        if (PART_MODALITY[part['type']] === undefined) continue
        fields.push(partField(part, part['type'], `${where}.content[${i}]`))
      }
    fields.push(...multimodalFields(item, where))
  }
  return fields
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
    const at = `${where}.content[${i}]`
    if (!modalities.includes(modality))
      return {
        ok: false,
        message:
          `The running embedding model does not read ${modality === 'image' ? 'images' : modality} (${at}.type is "${type}").` +
          (modality === 'video' ? ' Video input also needs ffmpeg installed on this computer.' : ''),
        param: at,
      }
    if (partReferences(part, type).some(isMediaReference))
      return {
        ok: false,
        message: `Media must be sent inline, as a data: URL or base64; links are not fetched (${at}).`,
        param: at,
      }
    const field = partField(part, type, at)
    const problem = fieldProblem(field)
    if (problem !== undefined) return { ok: false, message: problem, param: field.path }
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
      message:
        `The model returns ${dims}-dimension vectors and this server does not shorten them: drop 'dimensions' or send ${dims}. ` +
        'For a shorter length the model was trained for, keep the first values of each vector and L2-normalize them in your application.',
      param: 'dimensions',
    }
  for (const { item, where } of inputItems(input)) {
    if (!isRecord(item)) continue
    if (typeof item['type'] === 'string' && item['content'] === undefined && PART_TYPES.has(item['type']))
      return {
        ok: false,
        message: `${where} is a content part on its own; wrap it in an input item: {"content": [${JSON.stringify({ type: item['type'] })}]}.`,
        param: where,
      }
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
    for (const field of multimodalFields(item, where)) {
      const problem = fieldProblem(field)
      if (problem !== undefined) return { ok: false, message: problem, param: field.path }
    }
  }
  return { ok: true }
}

/**
 * What llama-server says, with a 500, for media it could not decode (`process_mtmd_prompt`) and for
 * bare base64 that decodes to nothing (`handle_media`).
 */
const UNDECODABLE_MEDIA = ['failed to load image or audio file', 'invalid base64 value']

/** The formats the engine decodes, for the modalities the model reads. */
function readableFormats(modalities: readonly EmbeddingModality[]): string {
  const formats: string[] = []
  if (modalities.includes('image'))
    formats.push('PNG, JPEG, GIF or BMP images (WebP needs ffmpeg on this computer)')
  if (modalities.includes('audio')) formats.push('WAV, MP3 or FLAC audio')
  if (modalities.includes('video')) formats.push('video ffmpeg reads')
  return formats.join('; ')
}

/**
 * The client error for the engine's 500 about media it could not decode, naming the media fields of the
 * request that carried it (the field itself when there is one); `undefined` for any other answer, and
 * for a request without media, whose 500 stays the engine's.
 */
export function undecodableMediaVerdict(
  status: number,
  engineBody: string,
  body: unknown,
  modalities: readonly EmbeddingModality[]
): { message: string; param?: string } | undefined {
  if (status !== 500) return undefined
  let message: unknown
  try {
    const parsed: unknown = JSON.parse(engineBody)
    message = isRecord(parsed) && isRecord(parsed['error']) ? parsed['error']['message'] : undefined
  } catch {
    return undefined
  }
  if (typeof message !== 'string') return undefined
  const said = message.toLowerCase()
  if (!UNDECODABLE_MEDIA.some((words) => said.includes(words))) return undefined
  const paths = mediaFields(body).map((field) => field.path)
  if (paths.length === 0) return undefined
  const where = paths.length === 1 ? paths[0]! : `One of ${paths.join(', ')}`
  const formats = readableFormats(modalities)
  return {
    message:
      `${where} could not be decoded as an image, audio or video file (the engine said: "${message}"). ` +
      `Send the file's own bytes, base64-encoded${formats ? `: ${formats}` : ''}.`,
    ...(paths.length === 1 ? { param: paths[0]! } : {}),
  }
}
