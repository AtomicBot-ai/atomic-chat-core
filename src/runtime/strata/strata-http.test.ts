import { expect, it, vi } from 'vitest'
import { strataHttp } from './strata-http.js'

const status = { instanceId: 'expected-instance' }
const telemetry = { instance: { id: status.instanceId }, model: { id: 'model', loaded: true } }

function probe(fetcher: typeof fetch) {
  return strataHttp(
    12345,
    'key',
    'model',
    { chat: true, tools: true, structured_output: true, vision: false, reasoning: true },
    8192,
    [],
    fetcher
  )
}

it.each([
  [() => Response.json(telemetry), undefined],
  [() => new Response(null, { status: 503 }), 'Strata telemetry returned HTTP 503.'],
  [() => new Response('not json'), 'Could not read the Strata telemetry JSON.'],
  [() => Response.json(null), 'Strata telemetry instance ID did not match.'],
  [
    () => Response.json({ ...telemetry, model: { id: 'other', loaded: true } }),
    'Strata telemetry model ID did not match.',
  ],
  [
    () => Response.json({ ...telemetry, model: { id: 'model', loaded: false } }),
    'Strata telemetry reported that the model was not loaded.',
  ],
] as const)('reports the HTTP health result as %s → %s', async (reply, reason) => {
  const fetcher = vi.fn(async () => reply())
  await expect(probe(fetcher).httpHealthFailure(status, new AbortController().signal)).resolves.toBe(reason)
  expect(fetcher).toHaveBeenCalledWith(
    'http://127.0.0.1:12345/v1/telemetry',
    expect.objectContaining({
      headers: { authorization: 'Bearer key' },
      redirect: 'error',
    })
  )
})

it('distinguishes an HTTP request timeout from an immediate connection failure', async () => {
  const lifecycle = new AbortController()
  const missing = probe(vi.fn().mockRejectedValue(new TypeError('fetch failed')))
  await expect(missing.httpHealthFailure(status, lifecycle.signal)).resolves.toBe(
    'Could not reach Strata telemetry.'
  )

  const timeout = new AbortController()
  const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal)
  try {
    const stalled = probe(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
        })
    )
    const result = stalled.httpHealthFailure(status, lifecycle.signal)
    timeout.abort(new DOMException('timed out', 'TimeoutError'))
    await expect(result).resolves.toBe('Strata telemetry timed out after 2000 ms.')
    expect(timeoutSpy).toHaveBeenCalledWith(2000)
  } finally {
    timeoutSpy.mockRestore()
  }
})

it('maps a context overflow to context_length_exceeded and leaves any other engine error to the server', () => {
  const { mapError } = probe(vi.fn()).policy
  // No Strata overflow answer is recorded yet: the shared wordings decide (unverified).
  expect(mapError(400, '{"error":{"message":"context length exceeded: 9000 > 8192"}}')).toMatchObject({
    error: { type: 'invalid_request_error', param: 'messages', code: 'context_length_exceeded' },
  })
  expect(
    mapError(
      400,
      '{"error":{"message":"request (9000 tokens) exceeds the available context size (8192 tokens)"}}'
    )
  ).toMatchObject({ error: { message: expect.stringMatching(/maximum context length is 8192 tokens/) } })
  expect(mapError(400, '{"error":{"message":"Strata accepts text and image_url content parts."}}')).toBeNull()
  expect(mapError(500, '{"error":{"message":"CUDA out of memory"}}')).toBeNull()
})
