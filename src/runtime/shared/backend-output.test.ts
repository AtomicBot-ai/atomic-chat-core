import { describe, expect, it } from 'vitest'
import { backendOutputReporter } from './backend-output.js'

const throwing = () => {
  throw new Error('sink boom')
}

describe('backendOutputReporter', () => {
  it('does nothing when no sink was given', () => {
    const warnings: string[] = []
    const report = backendOutputReporter(undefined, (_level, message) => warnings.push(message))
    expect(() => report({ provider: 'llamacpp', model: 'demo', stream: 'stdout', line: 'x' })).not.toThrow()
    expect(warnings).toEqual([])
  })

  it('forwards the line to the sink unchanged', () => {
    const seen: unknown[] = []
    const report = backendOutputReporter((line) => seen.push(line))
    report({
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

  it('swallows what the sink throws and warns once per session, without the engine line', () => {
    const logged: Array<[string, string]> = []
    const report = backendOutputReporter(throwing, (level, message) => logged.push([level, message]))
    for (const line of ['first secret line', 'second', 'third'])
      expect(() => report({ provider: 'mlx', model: 'm', stream: 'stdout', line })).not.toThrow()
    expect(logged).toEqual([
      ['warn', 'backendOutput sink threw: sink boom; further sink errors for this session are ignored'],
    ])

    // The next session gets its own reporter, and its own single warning.
    const next = backendOutputReporter(throwing, (level, message) => logged.push([level, message]))
    next({ provider: 'mlx', model: 'm', stream: 'stdout', line: 'again' })
    expect(logged).toHaveLength(2)
  })

  it('names a thrown value that is not an Error', () => {
    const logged: string[] = []
    const report = backendOutputReporter(
      () => {
        throw 'plain string'
      },
      (_level, message) => logged.push(message)
    )
    report({ provider: 'sd-cpp', model: 'z', stream: 'stderr', line: 'x' })
    expect(logged).toEqual([
      'backendOutput sink threw: plain string; further sink errors for this session are ignored',
    ])
  })

  it('stays silent about a throwing sink when there is no log to tell', () => {
    const report = backendOutputReporter(throwing)
    expect(() => report({ provider: 'mlx', model: 'm', stream: 'stdout', line: 'x' })).not.toThrow()
  })
})
