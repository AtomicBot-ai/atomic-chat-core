import { afterEach, describe, expect, it } from 'vitest'
import { isJsonObject } from '../shims/index.js'
import type { JsonObject, JsonValue } from '../shims/index.js'
import { withRunRoutes } from './runs-openapi.js'
import { OPENAPI_JSON } from './static-assets.generated.js'
import { closeAll, startPublic } from '../../../test/helpers/public-server.js'

afterEach(closeAll)

/* eslint-disable @typescript-eslint/no-explicit-any */
type Spec = {
  info: { title: string }
  tags: Array<{ name: string }>
  paths: Record<string, Record<string, any>>
  components: { schemas: Record<string, any> }
}

describe('withRunRoutes', () => {
  it("adds the run routes, their tag and error schema, and the opt-in header to the app's document", () => {
    const spec = JSON.parse(OPENAPI_JSON) as JsonValue
    withRunRoutes(spec)
    const doc = spec as unknown as Spec

    expect(doc.info.title).toBe('Atomic Chat API Server Endpoints')
    const events = doc.paths['/atomic/runs/{run_id}/events']?.['post']
    expect(events?.operationId).toBe('resumeChatCompletionRun')
    expect(events?.parameters.map((p: { name: string }) => p.name)).toEqual([
      'run_id',
      'after',
      'Last-Event-ID',
    ])
    expect(Object.keys(events?.responses).sort()).toEqual(['200', '400', '404', '410'])
    expect(Object.keys(events?.responses['200'].content)).toEqual(['text/event-stream'])
    expect(doc.paths['/atomic/runs/{run_id}/events']?.['get']).toBeUndefined()
    const cancel = doc.paths['/atomic/runs/{run_id}/cancel']?.['post']
    expect(cancel?.operationId).toBe('cancelChatCompletionRun')
    expect(Object.keys(cancel?.responses).sort()).toEqual(['204', '404'])
    expect(doc.tags.map((t) => t.name)).toContain('Runs')
    expect(doc.components.schemas['RunErrorDto'].properties.error.properties.code.enum).toEqual([
      'run_not_found',
      'run_events_gone',
      'invalid_value',
    ])
    const chat = doc.paths['/chat/completions']?.['post']
    expect(chat?.parameters).toEqual([expect.objectContaining({ name: 'X-Atomic-Resumable', in: 'header' })])
    // Everything the app's document described is still there.
    expect(chat?.operationId).toBe('createChatCompletion')
    expect(doc.paths['/images/generations']?.['post']?.operationId).toBe('createImageGeneration')
  })

  it('is idempotent, and leaves what the document already describes as it is', () => {
    const own = { post: { operationId: 'theAppsOwn' } }
    const spec: JsonObject = {
      tags: [{ name: 'Runs', description: 'the app' }],
      paths: {
        '/atomic/runs/{run_id}/cancel': own,
        '/chat/completions': { post: { parameters: [{ name: 'X-Atomic-Resumable', in: 'header' }] } },
      },
      components: { schemas: { RunErrorDto: { type: 'object' } } },
    }
    withRunRoutes(spec)
    const once = JSON.stringify(spec)
    withRunRoutes(spec)

    expect(JSON.stringify(spec)).toBe(once)
    const paths = spec['paths'] as JsonObject
    expect(paths['/atomic/runs/{run_id}/cancel']).toEqual(own)
    expect(Object.keys(paths)).toContain('/atomic/runs/{run_id}/events')
    expect(spec['tags']).toEqual([{ name: 'Runs', description: 'the app' }])
    expect((spec['components'] as any).schemas.RunErrorDto).toEqual({ type: 'object' })
    expect((paths['/chat/completions'] as any).post.parameters).toHaveLength(1)
  })

  it('builds what a bare document lacks, and leaves a document that is no object alone', () => {
    const bare: JsonObject = {}
    withRunRoutes(bare)
    expect(Object.keys(bare['paths'] as JsonObject).sort()).toEqual([
      '/atomic/runs/{run_id}/cancel',
      '/atomic/runs/{run_id}/events',
    ])
    expect(isJsonObject((bare['components'] as JsonObject)['schemas'])).toBe(true)
    expect(bare['tags']).toBeUndefined()

    const list: JsonValue = []
    withRunRoutes(list)
    expect(list).toEqual([])
  })

  it('is what the listener serves at /openapi.json', async () => {
    const server = await startPublic({})
    const doc = (await (await fetch(`http://127.0.0.1:${server.port}/openapi.json`)).json()) as Spec
    expect(doc.info.title).toBe('Atomic Chat API Server Endpoints')
    expect(doc.paths['/atomic/runs/{run_id}/events']?.['post']?.operationId).toBe('resumeChatCompletionRun')
    expect(doc.paths['/atomic/runs/{run_id}/cancel']?.['post']?.operationId).toBe('cancelChatCompletionRun')
  })
})
