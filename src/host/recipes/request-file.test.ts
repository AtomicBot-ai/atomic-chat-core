import { describe, expect, it } from 'vitest'
import { parseHostStepRequest, resultPathFor } from './request-file.js'

const digest = (c: string) => `sha256:${c.repeat(64)}`
const request = {
  schema_version: 1,
  step_id: 'step-1',
  operation_id: 'op-1',
  action: 'linux.install-container-runtime',
  recipe_id: 'linux.install-container-runtime',
  recipe_digest: digest('a'),
  parameters_digest: digest('b'),
  nonce: 'n-0123456789',
  expected_operation_revision: 3,
  data_folder: '/home/alice/.local/share/atomic-chat',
  requested_at: 1,
  parameters: { user: 'alice' },
}
const text = (value: unknown) => JSON.stringify(value)

describe('reading a host-step request file', () => {
  it('accepts the CLI request shape plus the parameters it carries', () => {
    const parsed = parseHostStepRequest(text(request))
    expect(parsed).toEqual({ ok: true, request })
  })

  it('accepts a request without requested_at', () => {
    const { requested_at: _omit, ...rest } = request
    expect(parseHostStepRequest(text(rest)).ok).toBe(true)
  })

  it.each<[string, string, RegExp]>([
    ['empty text', '', /not valid JSON/],
    ['not JSON', '{"step_id": ', /not valid JSON/],
    ['a JSON string', '"hello"', /object/],
    ['a JSON array', '[1,2]', /object/],
    ['null', 'null', /object/],
    ['another schema', text({ ...request, schema_version: 2 }), /schema_version/],
    ['an unknown action', text({ ...request, action: 'rm -rf /' }), /action/],
    ['a step id with a path in it', text({ ...request, step_id: '../../etc/x' }), /step_id/],
    ['an empty nonce', text({ ...request, nonce: '' }), /nonce/],
    ['a nonce that is a number', text({ ...request, nonce: 7 }), /nonce/],
    ['a digest that is not sha256', text({ ...request, recipe_digest: 'md5:00' }), /recipe_digest/],
    ['a short digest', text({ ...request, parameters_digest: 'sha256:abc' }), /parameters_digest/],
    ['a fractional revision', text({ ...request, expected_operation_revision: 1.5 }), /revision/],
    ['no parameters', text({ ...request, parameters: undefined }), /parameters/],
    ['parameters that are a list', text({ ...request, parameters: [] }), /parameters/],
    ['a missing data folder', text({ ...request, data_folder: undefined }), /data_folder/],
  ])('refuses %s', (_name, raw, message) => {
    const parsed = parseHostStepRequest(raw)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.problems.join('; ')).toMatch(message)
  })

  it('never repeats the file content back, so a request pointed at a secret file cannot leak it', () => {
    const parsed = parseHostStepRequest('root:$6$secrethash:19000:0:99999:7:::')
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.problems.join(' ')).not.toContain('secrethash')
  })

  it('echoes back the well-formed identifiers of a refused request, and only those', () => {
    const parsed = parseHostStepRequest(text({ ...request, recipe_digest: 'nope', action: 'x' }))
    expect(parsed).toMatchObject({
      ok: false,
      echo: {
        step_id: 'step-1',
        nonce: 'n-0123456789',
        recipe_id: 'linux.install-container-runtime',
        recipe_digest: null,
        parameters_digest: digest('b'),
      },
    })
  })
})

describe('the result path', () => {
  it('sits beside the request, as the CLI expects', () => {
    expect(resultPathFor('/x/step-1.request.json')).toBe('/x/step-1.result.json')
    expect(resultPathFor('/x/step-1.json')).toBeNull()
    expect(resultPathFor('/x/.request.json')).toBeNull()
  })
})
