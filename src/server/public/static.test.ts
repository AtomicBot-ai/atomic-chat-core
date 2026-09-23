import { afterEach, describe, expect, it } from 'vitest'
import { closeAll, startPublic } from '../../../test/helpers/public-server.js'

afterEach(closeAll)

describe('documentation routes', () => {
  it('points the OpenAPI servers at the bound address and prefix, without CORS headers', async () => {
    const server = await startPublic({}, { prefix: '/api' })

    const res = await fetch(`http://127.0.0.1:${server.port}/openapi.json`, {
      headers: { origin: 'http://localhost:3000' },
    })
    const spec = (await res.json()) as { servers: Array<{ url: string }> }

    expect(spec.servers.every((s) => s.url === `http://127.0.0.1:${server.port}/api`)).toBe(true)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })
})

describe('the OpenAPI document', () => {
  // `openapi_publishes_the_image_generation_contract` (`images_route.rs`, app commit ec1fd3ea7).
  it('publishes the image-generation contract the route serves', async () => {
    const server = await startPublic({})
    const spec = (await (await fetch(`http://127.0.0.1:${server.port}/openapi.json`)).json()) as {
      paths: Record<string, Record<string, any>> // eslint-disable-line @typescript-eslint/no-explicit-any
      components: { schemas: Record<string, any> } // eslint-disable-line @typescript-eslint/no-explicit-any
    }
    const operation = spec.paths['/images/generations']?.['post']
    expect(operation?.operationId).toBe('createImageGeneration')
    expect(operation?.tags[0]).toBe('Images')
    expect(operation?.requestBody.content['application/json'].schema.$ref).toBe(
      '#/components/schemas/CreateImageGenerationDto'
    )
    const request = spec.components.schemas['CreateImageGenerationDto']
    expect(request.required[0]).toBe('prompt')
    expect(request.properties.response_format.enum[0]).toBe('b64_json')
    expect(spec.components.schemas['ImageGenerationResponseDto'].properties.data.items.$ref).toBe(
      '#/components/schemas/ImageGenerationDataDto'
    )
    expect(operation?.responses['503']).toBeTypeOf('object')
    expect(operation?.responses['504']).toBeTypeOf('object')
  })

  // Stage 9g: the app's document describes the video facade the core serves (`videos.ts`).
  it('publishes the video contract the facade serves', async () => {
    const server = await startPublic({})
    const spec = (await (await fetch(`http://127.0.0.1:${server.port}/openapi.json`)).json()) as {
      tags: Array<{ name: string }>
      paths: Record<string, Record<string, any>> // eslint-disable-line @typescript-eslint/no-explicit-any
      components: { schemas: Record<string, any>; responses: Record<string, unknown> } // eslint-disable-line @typescript-eslint/no-explicit-any
    }
    expect(spec.tags.map((tag) => tag.name)).toContain('Videos')
    const create = spec.paths['/videos']?.['post']
    expect(create?.operationId).toBe('createVideo')
    expect(create?.tags).toEqual(['Videos'])
    expect(create?.requestBody.content['application/json'].schema.$ref).toBe(
      '#/components/schemas/CreateVideoDto'
    )
    expect(create?.responses['200'].content['application/json'].schema.$ref).toBe(
      '#/components/schemas/VideoDto'
    )
    expect(spec.paths['/videos']?.['get']?.operationId).toBe('listVideos')
    expect(spec.paths['/videos/{video_id}']?.['get']?.operationId).toBe('retrieveVideo')
    expect(spec.paths['/videos/{video_id}']?.['delete']?.operationId).toBe('deleteVideo')
    const content = spec.paths['/videos/{video_id}/content']?.['get']
    expect(content?.operationId).toBe('downloadVideoContent')
    expect(Object.keys(content?.responses['200'].content).sort()).toEqual(['image/png', 'video/webm'])
    const request = spec.components.schemas['CreateVideoDto']
    expect(request.required).toEqual(['prompt'])
    // The served document is re-serialised with sorted keys; compare as sets.
    expect(Object.keys(request.properties).sort()).toEqual(
      ['model', 'prompt', 'seconds', 'size', 'seed', 'negative_prompt'].sort()
    )
    const video = spec.components.schemas['VideoDto']
    expect(video.properties.status.enum).toEqual(['queued', 'in_progress', 'completed', 'failed'])
    expect(video.properties.atomic.$ref).toBe('#/components/schemas/VideoAtomicDto')
    expect(spec.components.responses['VideoApiError']).toBeTypeOf('object')
  })
})
