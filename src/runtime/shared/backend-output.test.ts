import { describe, expect, it } from 'vitest'
import { reportBackendOutput } from './backend-output.js'

describe('reportBackendOutput', () => {
  it('does nothing when no sink was given', () => {
    expect(() =>
      reportBackendOutput(undefined, { provider: 'llamacpp', model: 'demo', stream: 'stdout', line: 'x' })
    ).not.toThrow()
  })

  it('forwards the line to the sink unchanged', () => {
    const seen: unknown[] = []
    reportBackendOutput((line) => seen.push(line), {
      provider: 'llamacpp-upstream',
      model: 'qwen3-8b',
      stream: 'stderr',
      line: 'main: server is listening',
    })
    expect(seen).toEqual([
      {
        provider: 'llamacpp-upstream',
        model: 'qwen3-8b',
        stream: 'stderr',
        line: 'main: server is listening',
      },
    ])
  })

  it('swallows an exception the sink throws, instead of letting it escape', () => {
    expect(() =>
      reportBackendOutput(
        () => {
          throw new Error('sink boom')
        },
        { provider: 'mlx', model: 'm', stream: 'stdout', line: 'x' }
      )
    ).not.toThrow()
  })
})
