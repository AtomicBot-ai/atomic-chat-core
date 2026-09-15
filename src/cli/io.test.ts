import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeTmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import { nodeCliIo, recordingIo, selectOption } from './io.js'

let data: TmpDataFolder
beforeEach(async () => {
  data = await makeTmpDataFolder('atomic-core-io-')
})
afterEach(() => data.cleanup())

describe('recordingIo', () => {
  it('collects output instead of printing it and runs the stop handler immediately', async () => {
    const io = recordingIo()
    io.stdout('out')
    io.stderr('err')
    expect(io.out).toEqual(['out'])
    expect(io.err).toEqual(['err'])
    let stopped = false
    await io.waitForShutdown(async () => {
      stopped = true
    })
    expect(stopped).toBe(true)
  })

  it('accepts overrides for the environment and fetch', async () => {
    const io = recordingIo({ env: { ATOMIC_API_KEY: 'k' }, fetch: async () => new Response('x') })
    expect(io.env['ATOMIC_API_KEY']).toBe('k')
    expect(await (await io.fetch('http://unused')).text()).toBe('x')
  })
})

describe('nodeCliIo', () => {
  it('reads a file that exists and reports a missing one as undefined', async () => {
    const io = nodeCliIo()
    const path = join(data.root, 'note.txt')
    await writeFile(path, 'hello')
    expect(await io.readFile(path)).toBe('hello')
    expect(await io.readFile(join(data.root, 'nope.txt'))).toBeUndefined()
    expect(io.env).toBe(process.env)
    expect(io.cwd).toBe(process.cwd())
    io.stdout('')
    io.stderr('')
    expect(await (await io.fetch('data:text/plain,ok')).text()).toBe('ok')
  })

  it('runs one shutdown handler and removes both signal listeners', async () => {
    const io = nodeCliIo()
    let calls = 0
    const waiting = io.waitForShutdown(async () => {
      calls++
    })
    process.emit('SIGTERM', 'SIGTERM')
    await waiting
    process.emit('SIGTERM', 'SIGTERM')
    expect(calls).toBe(1)
  })
})

describe('selectOption', () => {
  const terminal = (answer: string, writes: string[] = []) => ({
    interactive: true,
    write: (text: string) => writes.push(text),
    question: async () => answer,
  })

  it('renders choices and accepts the default or a numbered selection', async () => {
    const writes: string[] = []
    expect(await selectOption('Pick', ['a', 'b'], terminal('', writes))).toBe(0)
    expect(writes.join('')).toContain('2. b')
    expect(await selectOption('Pick', ['a', 'b'], terminal('2'))).toBe(1)
  })

  it('rejects non-interactive and invalid selections', async () => {
    await expect(selectOption('Pick', ['a'], { ...terminal('1'), interactive: false })).rejects.toThrow(
      /interactive/
    )
    await expect(selectOption('Pick', ['a'], terminal('2'))).rejects.toThrow(/Invalid/)
  })
})
