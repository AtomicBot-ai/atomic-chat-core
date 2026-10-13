import { describe, expect, it } from 'vitest'
import type { ImageModelDescriptor } from '../../contracts/index.js'
import {
  bytesResponse,
  fakeMediaFetch,
  JPEG_STUB,
  jsonResponse,
  mediaContext,
  PNG_1X1,
} from '../../../test/helpers/media-fetch.js'
import {
  MISTRAL_AGENT_IMAGE,
  MISTRAL_IMAGE_INSTRUCTION,
  mistralConversation,
  mistralToolFiles,
} from './mistral-agent-image.js'
import type { ImageGenerationJob, RemoteProgress } from './types.js'

const BASE = 'https://api.mistral.ai/v1'

const model: ImageModelDescriptor = {
  id: 'mistral-medium-latest',
  name: 'FLUX1.1 Ultra via Mistral Agents',
  api: 'mistral-agent-image',
  kind: 'image',
  source: 'catalog',
  workflows: ['create'],
  params: {},
}

function job(overrides: Partial<ImageGenerationJob> = {}): ImageGenerationJob {
  return { model, prompt: 'an orange cat in an office', workflow: 'create', n: 1, images: [], ...overrides }
}

function answer(fileId: string, said = 'Here is your image.'): unknown {
  return {
    object: 'conversation.response',
    conversation_id: 'conv_1',
    outputs: [
      { type: 'tool.execution', name: 'image_generation', object: 'entry' },
      {
        type: 'message.output',
        role: 'assistant',
        content: [
          { type: 'text', text: said },
          {
            type: 'tool_file',
            tool: 'image_generation',
            file_id: fileId,
            file_name: 'image_generated_0',
            file_type: 'png',
          },
        ],
      },
    ],
    usage: { prompt_tokens: 1 },
  }
}

describe('mistralToolFiles', () => {
  it('finds tool_file chunks and the words wherever they sit', () => {
    expect(mistralToolFiles(answer('f-1'))).toEqual({
      files: [{ fileId: 'f-1', fileName: 'image_generated_0', fileType: 'png' }],
      text: 'Here is your image.',
    })
    expect(
      mistralToolFiles({
        output: [
          {
            chunks: [
              { type: 'tool_file', file_id: 'a' },
              { type: 'tool_file', file_id: 'a' },
            ],
          },
        ],
      })
    ).toEqual({ files: [{ fileId: 'a' }], text: '' })
  })

  it('collects a plain string content as the words', () => {
    expect(
      mistralToolFiles({ outputs: [{ type: 'message.output', content: 'I cannot   help with that.' }] })
    ).toEqual({ files: [], text: 'I cannot help with that.' })
  })
})

describe('mistralConversation', () => {
  it('asks the model for one image with the tool, without storing the conversation', () => {
    expect(mistralConversation(job())).toEqual({
      model: 'mistral-medium-latest',
      inputs: `${MISTRAL_IMAGE_INSTRUCTION}\n\nan orange cat in an office`,
      tools: [{ type: 'image_generation' }],
      store: false,
    })
  })
})

describe('MISTRAL_AGENT_IMAGE', () => {
  it('starts a conversation and downloads the tool file with the key', async () => {
    const { fetch, requests } = fakeMediaFetch([
      {
        method: 'POST',
        url: `${BASE}/conversations`,
        answer: [jsonResponse(answer('f-1')), jsonResponse(answer('f-2'))],
      },
      {
        method: 'GET',
        url: `${BASE}/files/f-1/content`,
        answer: bytesResponse(PNG_1X1, 'application/octet-stream'),
      },
      {
        method: 'GET',
        url: `${BASE}/files/f-2/content`,
        answer: bytesResponse(JPEG_STUB, 'application/octet-stream'),
      },
    ])
    const seen: RemoteProgress[] = []
    const images = await MISTRAL_AGENT_IMAGE.generate(
      mediaContext({ fetch, baseUrl: BASE }),
      job({ n: 2 }),
      (p) => seen.push(p)
    )
    expect(images.map((i) => i.mime)).toEqual(['image/png', 'image/jpeg'])
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      `POST ${BASE}/conversations`,
      `GET ${BASE}/files/f-1/content`,
      `POST ${BASE}/conversations`,
      `GET ${BASE}/files/f-2/content`,
    ])
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer sk-test')
    expect(requests[1]?.headers.get('authorization')).toBe('Bearer sk-test')
    expect(seen).toEqual([
      { phase: 'generating' },
      { phase: 'generating', fraction: 0.5 },
      { phase: 'generating', fraction: 1 },
    ])
  })

  it('answers what the model said when it made no image', async () => {
    const { fetch } = fakeMediaFetch([
      {
        method: 'POST',
        url: `${BASE}/conversations`,
        answer: jsonResponse({
          outputs: [{ type: 'message.output', content: [{ type: 'text', text: 'Which cat?' }] }],
        }),
      },
    ])
    await expect(
      MISTRAL_AGENT_IMAGE.generate(mediaContext({ fetch, baseUrl: BASE }), job(), () => {})
    ).rejects.toMatchObject({
      code: 'REMOTE_REJECTED',
      message: 'test: Which cat?',
    })
  })

  it('maps an HTTP error and refuses other workflows', async () => {
    const { fetch } = fakeMediaFetch([
      {
        method: 'POST',
        url: `${BASE}/conversations`,
        answer: jsonResponse({ message: 'Unauthorized' }, 401),
      },
    ])
    const ctx = mediaContext({ fetch, baseUrl: BASE })
    await expect(MISTRAL_AGENT_IMAGE.generate(ctx, job(), () => {})).rejects.toMatchObject({
      code: 'REMOTE_AUTH_FAILED',
    })
    await expect(
      MISTRAL_AGENT_IMAGE.generate(
        ctx,
        job({ workflow: 'edit', images: [{ bytes: PNG_1X1, mime: 'image/png' }] }),
        () => {}
      )
    ).rejects.toMatchObject({ code: 'REMOTE_UNSUPPORTED' })
  })

  it('refuses a file that is not an image', async () => {
    const { fetch } = fakeMediaFetch([
      { method: 'POST', url: `${BASE}/conversations`, answer: jsonResponse(answer('f-1')) },
      {
        method: 'GET',
        url: `${BASE}/files/f-1/content`,
        answer: bytesResponse(Buffer.from('nope'), 'text/plain'),
      },
    ])
    await expect(
      MISTRAL_AGENT_IMAGE.generate(mediaContext({ fetch, baseUrl: BASE }), job(), () => {})
    ).rejects.toMatchObject({
      code: 'REMOTE_UNAVAILABLE',
    })
  })
})
