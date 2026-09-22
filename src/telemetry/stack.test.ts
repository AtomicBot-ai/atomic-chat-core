import { describe, expect, it } from 'vitest'
import { framePath, parseStack } from './stack.js'

describe('framePath', () => {
  it.each([
    ['src/core/create.ts', 'src/core/create.ts'],
    ['/Users/misha/Work/atomic-chat-core/src/core/create.ts', 'src/core/create.ts'],
    ['file:///Users/misha/atomic-chat-core/dist/core/create.js', 'dist/core/create.js'],
    ['C:\\Users\\misha\\core\\src\\app-daemon.ts', 'src/app-daemon.ts'],
    ['file:///C:/Users/misha/core/dist/app-daemon.js', 'dist/app-daemon.js'],
    ['/$bunfs/root/atomic-chat-app-core', 'atomic-chat-app-core'],
    ['/Users/misha/node_modules/yaml/dist/index.js', 'node_modules/yaml/dist/index.js'],
    ['/Users/misha/src/atomic-chat-core/src/core/x.ts', 'src/core/x.ts'],
    ['/Users/misha/elsewhere/tool.js', 'tool.js'],
    ['native', 'native'],
    ['node:internal/process/task_queues', 'node:internal/process/task_queues'],
  ])('%s → %s', (raw, expected) => {
    expect(framePath(raw)).toBe(expected)
  })
})

describe('parseStack', () => {
  it('reads a Bun stack oldest-first, keeping names and the native frames', () => {
    const stack = [
      'Error: boom here',
      '    at boom (src/core/create.ts:3:36)',
      '    at async start (src/app-daemon.ts:5:7)',
      '    at src/app-daemon.ts:9:1',
      '    at moduleEvaluation (native:1:11)',
      '    at loadAndEvaluateModule (native:2)',
    ].join('\n')
    expect(parseStack(stack)).toEqual([
      { function: 'loadAndEvaluateModule', filename: 'native', lineno: 2, in_app: false },
      { function: 'moduleEvaluation', filename: 'native', lineno: 1, colno: 11, in_app: false },
      { filename: 'src/app-daemon.ts', lineno: 9, colno: 1, in_app: true },
      { function: 'start', filename: 'src/app-daemon.ts', lineno: 5, colno: 7, in_app: true },
      { function: 'boom', filename: 'src/core/create.ts', lineno: 3, colno: 36, in_app: true },
    ])
  })

  it('reads a Node stack with absolute paths and constructors', () => {
    const stack = [
      'TypeError: x is not a function',
      '    at new Thing (/Users/misha/core/dist/core/thing.js:10:5)',
      '    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)',
    ].join('\n')
    expect(parseStack(stack)).toEqual([
      {
        function: 'process.processTicksAndRejections',
        filename: 'node:internal/process/task_queues',
        lineno: 95,
        colno: 5,
        in_app: false,
      },
      { function: 'new Thing', filename: 'dist/core/thing.js', lineno: 10, colno: 5, in_app: true },
    ])
  })

  it('keeps a Windows drive path whole', () => {
    expect(parseStack('    at f (C:\\a\\src\\x.ts:1:2)')).toEqual([
      { function: 'f', filename: 'src/x.ts', lineno: 1, colno: 2, in_app: true },
    ])
  })

  it('ignores lines that are not frames and caps a runaway stack', () => {
    expect(parseStack(undefined)).toEqual([])
    expect(parseStack('Error: only a message\ncaused by nothing\n    at fn ()')).toEqual([])
    const long = Array.from({ length: 80 }, (_, i) => `    at f${i} (src/x.ts:${i + 1}:1)`).join('\n')
    const frames = parseStack(long)
    expect(frames).toHaveLength(50)
    expect(frames.at(-1)?.function).toBe('f0')
  })
})
