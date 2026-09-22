import { describe, expect, it } from 'vitest'
import { OutputParser, readyUrl } from './cloudflared-output.js'

const FAKE_URL = 'https://calm-river-demo.trycloudflare.com'

// The parser tests of the app's `remote_access/process.rs`, one for one.
describe('OutputParser', () => {
  it('pulls the URL out of a noisy line', () => {
    const parser = new OutputParser()
    expect(parser.feedLine('INF Requesting new quick Tunnel on trycloudflare.com...')).toBe(false)
    expect(parser.feedLine(`INF |  ${FAKE_URL}  |`)).toBe(true)
    expect(parser.snapshot().url).toBe(FAKE_URL)
  })

  it('never mistakes the control host for a tunnel', () => {
    const parser = new OutputParser()
    expect(
      parser.feedLine('ERR failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": EOF')
    ).toBe(false)
    expect(parser.snapshot().url).toBeUndefined()
    // …but a real URL on the same line as the control host is still found.
    expect(parser.feedLine(`INF https://api.trycloudflare.com/tunnel answered ${FAKE_URL}`)).toBe(true)
    expect(parser.snapshot().url).toBe(FAKE_URL)
  })

  it('does not treat a URL alone as ready', () => {
    const parser = new OutputParser()
    parser.feedLine(FAKE_URL)
    expect(readyUrl(parser.snapshot())).toBeUndefined()
    expect(parser.feedLine('INF Registered tunnel connection connIndex=0')).toBe(true)
    expect(readyUrl(parser.snapshot())).toBe(FAKE_URL)
    // Registered again (cloudflared opens several connections): no change.
    expect(parser.feedLine('INF Registered tunnel connection connIndex=1')).toBe(false)
  })

  it('lets the first URL win', () => {
    const parser = new OutputParser()
    parser.feedLine(FAKE_URL)
    expect(parser.feedLine('https://second-name.trycloudflare.com')).toBe(false)
    expect(parser.snapshot().url).toBe(FAKE_URL)
  })

  it('is not ready when it registered without ever naming a tunnel', () => {
    const parser = new OutputParser()
    parser.feedLine('INF Registered tunnel connection connIndex=0')
    expect(parser.snapshot()).toEqual({ url: undefined, registered: true })
    expect(readyUrl(parser.snapshot())).toBeUndefined()
  })

  it('keeps its scan position to itself between lines', () => {
    // A global regular expression remembers where it stopped; two parsers, or two lines, must not
    // inherit that from each other.
    const first = new OutputParser()
    first.feedLine(`padding padding padding ${FAKE_URL}`)
    const second = new OutputParser()
    expect(second.feedLine(FAKE_URL)).toBe(true)
  })
})
