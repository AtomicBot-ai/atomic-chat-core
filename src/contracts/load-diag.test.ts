import { describe, expect, it } from 'vitest'
import { LOAD_DIAG_PREFIX, formatLoadDiag, parseLoadDiag, stripLoadDiag, withLoadDiag } from './load-diag.js'

describe('load diag line', () => {
  it('formats without empty fields and parses back', () => {
    const line = formatLoadDiag({
      exit_code: '0xC0000135',
      stage: 'spawn',
      backend: 'win-cpu-x64',
      build: '',
    })
    expect(line).toBe(`${LOAD_DIAG_PREFIX}{"exit_code":"0xC0000135","stage":"spawn","backend":"win-cpu-x64"}`)
    expect(parseLoadDiag(`stderr line\n${line}`)).toEqual({
      exit_code: '0xC0000135',
      stage: 'spawn',
      backend: 'win-cpu-x64',
    })
  })

  it('keeps one diag line at the end of details', () => {
    const once = withLoadDiag('boom\n', { stage: 'load' })
    const twice = withLoadDiag(once, { stage: 'ready', fallback_ok: true })
    expect(twice).toBe(`boom\n${LOAD_DIAG_PREFIX}{"stage":"ready","fallback_ok":true}`)
    expect(stripLoadDiag(twice)).toBe('boom')
    expect(withLoadDiag(undefined, { empty_stderr: true })).toBe(`${LOAD_DIAG_PREFIX}{"empty_stderr":true}`)
  })

  it('returns undefined for missing or malformed lines', () => {
    expect(parseLoadDiag(undefined)).toBeUndefined()
    expect(parseLoadDiag('no diag here')).toBeUndefined()
    expect(parseLoadDiag(`${LOAD_DIAG_PREFIX}{not json`)).toBeUndefined()
  })
})
