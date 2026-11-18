import { expect, it } from 'vitest'
import { strataRequest } from './strata-policy.js'
const caps = { chat: true, tools: true, reasoning: true, vision: true, structured_output: true } as const
it('passes chat/tool input and restricts vision to inline raster data', () => {
  const image = (url: string) => ({
    messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url } }] }],
  })
  const inline = image('data:image/png;base64,AQID')
  expect(strataRequest(inline, caps)).toEqual(inline)
  expect(() => strataRequest(image('https://example.invalid/image.png'), caps)).toThrow(/data URL/)
  expect(() => strataRequest(inline, { ...caps, vision: false })).toThrow(/vision/i)
})
it('requires the full validator and refuses JSON together with tools', () => {
  const body = { messages: [], response_format: { type: 'json_object' } }
  expect(strataRequest(body, caps)).toEqual(body)
  expect(() => strataRequest(body, { ...caps, structured_output: false })).toThrow(/validator/)
  expect(() => strataRequest({ ...body, tools: [{ type: 'function' }] }, caps)).toThrow(/tools/i)
  expect(() => strataRequest({ messages: [], response_format: { type: 'xml' } }, caps)).toThrow(
    /response_format/
  )
})

it('rejects producer control fields on the inference route', () => {
  expect(() => strataRequest({ messages: [], strata_mcp: true }, caps)).toThrow(/control fields/)
})
