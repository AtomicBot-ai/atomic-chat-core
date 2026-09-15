import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { describe, expect, it } from 'vitest'

// Runs under vitest (Node) and must also pass under the Bun binary (bun test). Pins the process and
// socket behaviour the runtime depends on. PLAN.md §5.1 "Runtime-compat".

describe('child_process', () => {
  it('captures exit code and stdout of a child', async () => {
    const child = spawn(process.execPath, ['-e', 'process.stdout.write("hi"); process.exit(3)'], {
      windowsHide: true,
    })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    const code = await new Promise<number | null>((r) => child.on('exit', r))
    expect(out).toBe('hi')
    expect(code).toBe(3)
  })

  it('terminates a hanging child with kill()', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true })
    await new Promise((r) => setTimeout(r, 200))
    expect(child.kill()).toBe(true)
    const [code, signal] = await new Promise<[number | null, string | null]>((r) =>
      child.on('exit', (c, s) => r([c, s]))
    )
    expect(code === null ? signal : code).not.toBeNull()
  })
})

describe('net', () => {
  it('binds an ephemeral loopback port and reports it', async () => {
    const server = createServer()
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const addr = server.address()
    expect(typeof addr === 'object' && addr !== null && addr.port > 0).toBe(true)
    await new Promise<void>((r) => server.close(() => r()))
  })
})
