import { describe, expect, it } from 'vitest'
import {
  classifyDownloadStatus,
  classifyResumeStatus,
  DownloadRequestError,
  expectedDownloadSize,
  isRetryableStatus,
  retryDelayMs,
  shouldBypassProxy,
  sidecarPath,
  validateContentRange,
  validateProxyConfig,
} from './protocol.js'

describe('sidecarPath / retryDelayMs', () => {
  it('appends the extension and backs off exponentially with a cap', () => {
    expect(sidecarPath('/m/model.gguf', 'tmp')).toBe('/m/model.gguf.tmp')
    expect(sidecarPath('/m/archive.tar.gz', 'url')).toBe('/m/archive.tar.gz.url')
    expect(sidecarPath('/m/noext', 'tmp')).toBe('/m/noext.tmp')
    expect([0, 1, 2, 6, 7, 20].map((n) => retryDelayMs(n))).toEqual([1000, 2000, 4000, 64000, 64000, 64000])
    expect(retryDelayMs(3, 1)).toBe(8)
  })
})

describe('status classification', () => {
  it('retries 408/429/5xx only', () => {
    expect([408, 429, 500, 503].every(isRetryableStatus)).toBe(true)
    expect([200, 206, 400, 401, 403, 404, 416].some(isRetryableStatus)).toBe(false)
  })
  it('maps resume and plain statuses to kinds with the Rust messages', () => {
    expect(classifyResumeStatus(200, '')).toMatchObject({ kind: 'restart' })
    expect(classifyResumeStatus(416, '')).toMatchObject({ kind: 'restart' })
    expect(classifyResumeStatus(503, '')).toMatchObject({
      kind: 'retryable',
      message: 'Resume request failed with HTTP status 503',
    })
    expect(classifyResumeStatus(403, 'nope')).toMatchObject({
      kind: 'fatal',
      message: 'Failed to resume download: HTTP status 403, nope',
    })
    expect(classifyDownloadStatus(429, 'slow')).toMatchObject({
      kind: 'retryable',
      message: 'Failed to download: HTTP status 429, slow',
    })
    expect(classifyDownloadStatus(404, 'gone')).toMatchObject({ kind: 'fatal' })
  })
})

describe('validateContentRange', () => {
  const expectRestart = (fn: () => void, re: RegExp) => {
    try {
      fn()
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(DownloadRequestError)
      expect((e as DownloadRequestError).kind).toBe('restart')
      expect((e as Error).message).toMatch(re)
    }
  }
  it('accepts a matching range with a known or unknown total', () => {
    expect(() => validateContentRange('bytes 100-999/1000', 100, 1000)).not.toThrow()
    expect(() => validateContentRange('bytes 100-999/*', 100, 1000)).not.toThrow()
    expect(() => validateContentRange('bytes 100-999/1000', 100, 0)).not.toThrow()
  })
  it('rejects every malformed or mismatching shape with restart', () => {
    expectRestart(() => validateContentRange(null, 100, 1000), /missing the Content-Range header/)
    expectRestart(() => validateContentRange('items 1-2/3', 100, 1000), /unsupported Content-Range value/)
    expectRestart(() => validateContentRange('bytes 1-2', 1, 3), /invalid Content-Range value/)
    expectRestart(() => validateContentRange('bytes 12/3', 1, 3), /invalid Content-Range value/)
    expectRestart(() => validateContentRange('bytes x-2/3', 1, 3), /invalid Content-Range start/)
    expectRestart(() => validateContentRange('bytes 1-y/3', 1, 3), /invalid Content-Range end/)
    expectRestart(() => validateContentRange('bytes 1-2/z', 1, 3), /invalid Content-Range total/)
    expectRestart(
      () => validateContentRange('bytes 50-999/1000', 100, 1000),
      /does not match the requested offset/
    )
    expectRestart(
      () => validateContentRange('bytes 100-50/1000', 100, 1000),
      /does not match the requested offset/
    )
    expectRestart(() => validateContentRange('bytes 100-1000/1000', 100, 1000), /exceeds its declared total/)
    expectRestart(() => validateContentRange('bytes 100-999/1000', 100, 2000), /Remote file size changed/)
  })
})

describe('proxy rules', () => {
  it('validates proxy configs like the Rust side', () => {
    expect(validateProxyConfig({ url: 'http://p:8080' })).toBeUndefined()
    expect(
      validateProxyConfig({ url: 'socks5://p:1080', username: 'u', password: 'p', no_proxy: ['*.local'] })
    ).toBeUndefined()
    expect(validateProxyConfig({ url: 'not a url' })).toMatch(/^Invalid proxy URL/)
    expect(validateProxyConfig({ url: 'ftp://p' })).toBe('Unsupported proxy scheme: ftp')
    expect(validateProxyConfig({ url: 'http://p', username: 'u' })).toBe('Username provided without password')
    expect(validateProxyConfig({ url: 'http://p', password: 'p' })).toBe('Password provided without username')
    expect(validateProxyConfig({ url: 'http://p', no_proxy: [''] })).toBe('Empty no_proxy entry')
    expect(validateProxyConfig({ url: 'http://p', no_proxy: ['*.'] })).toBe('Invalid wildcard pattern: *.')
  })
  it('bypasses by wildcard, suffix and exact host', () => {
    expect(shouldBypassProxy('https://hf.co/x', [])).toBe(false)
    expect(shouldBypassProxy('https://hf.co/x', ['*'])).toBe(true)
    expect(shouldBypassProxy('https://cdn.hf.co/x', ['*.hf.co'])).toBe(true)
    expect(shouldBypassProxy('https://hf.co/x', ['hf.co'])).toBe(true)
    expect(shouldBypassProxy('https://hf.co/x', ['other.co'])).toBe(false)
    expect(shouldBypassProxy('nonsense', ['*'])).toBe(false)
  })
  it('expectedDownloadSize prefers a positive catalog size', () => {
    expect(expectedDownloadSize(123, 999)).toBe(123)
    expect(expectedDownloadSize(0, 999)).toBe(999)
    expect(expectedDownloadSize(undefined, 999)).toBe(999)
  })
})
