import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createWsl, decodeWslBytes, defaultWslExecutable, type Wsl } from './transport.js'

const FAKE_WSL = fileURLToPath(new URL('../../../test/helpers/fake-wsl.mjs', import.meta.url))

let dir: string
let wsl: Wsl

const writeState = (state: Record<string, unknown>): void =>
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state))

/** Every argv the fake `wsl.exe` was started with, in order, and whether it was asked for UTF-8. */
const calls = (): { argv: string[]; wsl_utf8: string | null }[] =>
  readFileSync(join(dir, 'calls.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { argv: string[]; wsl_utf8: string | null })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fake-wsl-'))
  writeState({
    installed: true,
    distributions: [
      { name: 'Ubuntu', state: 'Stopped', version: 2, is_default: true },
      { name: 'AtomicChat', state: 'Running', version: 2, is_default: false },
    ],
    guests: {},
  })
  wsl = createWsl({ executable: process.execPath, executableArgs: [FAKE_WSL, dir] })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('createWsl — a command inside one distribution', () => {
  it('runs argv through `-d <distro> -u <user> --exec`, every argument verbatim, with no shell', async () => {
    const argv = ['echo', 'a b', '"quoted"', '$(id)', '%PATH%', 'x&y', ';ls', '\\\\wsl.localhost\\x']
    const out = await wsl.distribution('AtomicChat').exec(argv, { user: 'root' })

    expect(out).toEqual({ code: 0, stdout: `${argv.slice(1).join(' ')}\n`, stderr: '' })
    expect(calls().at(-1)?.argv).toEqual(['-d', 'AtomicChat', '-u', 'root', '--exec', ...argv])
  })

  it('leaves `-u` out when no user is named, so the guest runs it as its default user', async () => {
    await wsl.distribution('AtomicChat').exec(['true'])
    expect(calls().at(-1)?.argv).toEqual(['-d', 'AtomicChat', '--exec', 'true'])
  })

  it('asks wsl.exe for UTF-8 on every call (`WSL_UTF8=1`)', async () => {
    await wsl.distribution('AtomicChat').exec(['true'])
    await wsl.command(['--list', '--verbose'])
    expect(calls().map((call) => call.wsl_utf8)).toEqual(['1', '1'])
  })

  it('passes the guest’s own UTF-8 bytes through, non-ASCII included', async () => {
    const out = await wsl.distribution('AtomicChat').exec(['echo', 'модель', '模型'])
    expect(out.stdout).toBe('модель 模型\n')
  })

  it('reports a nonzero exit as it is, with the guest’s stderr', async () => {
    const out = await wsl.distribution('AtomicChat').exec(['cat', '/etc/missing'])
    expect(out.code).toBe(1)
    expect(out.stderr).toContain('No such file or directory')
  })

  it('pipes `input` to the command’s stdin (how a file is written into the guest without a shell)', async () => {
    const out = await wsl.distribution('AtomicChat').exec(['cat'], { input: '[boot]\nsystemd=true\n' })
    expect(out).toEqual({ code: 0, stdout: '[boot]\nsystemd=true\n', stderr: '' })
  })

  it('streams stdout as it arrives, in order, as well as returning it whole', async () => {
    const seen: string[] = []
    const out = await wsl
      .distribution('AtomicChat')
      .exec(['fake-stream', 'one', 'two', 'three'], { onStdout: (text) => seen.push(text) })

    expect(seen.join('')).toBe('one\ntwo\nthree\n')
    expect(seen.length).toBeGreaterThan(1)
    expect(out.stdout).toBe('one\ntwo\nthree\n')
  })

  it('answers `code: null` past its deadline, and stops the process', async () => {
    const started = Date.now()
    const out = await wsl.distribution('AtomicChat').exec(['sleep', 'infinity'], { timeoutMs: 200 })

    expect(out.code).toBeNull()
    expect(out.stderr).toMatch(/did not answer within 200 ms/)
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('answers `code: null` when aborted, and stops the process', async () => {
    const controller = new AbortController()
    const pending = wsl.distribution('AtomicChat').exec(['sleep', 'infinity'], { signal: controller.signal })
    setTimeout(() => controller.abort(), 100)
    const out = await pending
    expect(out.code).toBeNull()
    expect(out.stderr).toMatch(/aborted/)
  })

  it('does not even start a command whose signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const out = await wsl.distribution('AtomicChat').exec(['true'], { signal: controller.signal })
    expect(out.code).toBeNull()
    expect(() => calls()).toThrow()
  })

  it('keeps the start and the end of an output larger than its cap, dropping the middle', async () => {
    const small = createWsl({
      executable: process.execPath,
      executableArgs: [FAKE_WSL, dir],
      maxOutputBytes: 64,
    })
    const out = await small.distribution('AtomicChat').exec(['fake-flood', '100000'])
    expect(out.code).toBe(0)
    expect(out.stdout.length).toBeLessThanOrEqual(64)
  })

  it('answers `code: null` when the executable is not on the machine', async () => {
    const missing = createWsl({ executable: join(dir, 'no-such-wsl.exe') })
    const out = await missing.distribution('AtomicChat').exec(['true'])
    expect(out.code).toBeNull()
  })

  it('decodes wsl.exe’s own UTF-16 error for a distribution that does not exist', async () => {
    const legacy = createWsl({
      executable: process.execPath,
      executableArgs: [FAKE_WSL, dir],
      // An older WSL that ignores WSL_UTF8 still answers in UTF-16: the decoder copes either way.
      env: { ...process.env, WSL_UTF8: '0' },
      utf8: false,
    })
    const out = await legacy.distribution('Missing').exec(['true'])
    expect(out.code).not.toBe(0)
    expect(out.stdout).toBe('There is no distribution with the supplied name.\r\n')
  })
})

describe('createWsl — wsl.exe’s own commands', () => {
  it('passes the arguments verbatim and decodes the UTF-16 table into plain text', async () => {
    const legacy = createWsl({
      executable: process.execPath,
      executableArgs: [FAKE_WSL, dir],
      env: { ...process.env, WSL_UTF8: '0' },
      utf8: false,
    })
    const out = await legacy.command(['--list', '--verbose'])

    expect(calls().at(-1)?.argv).toEqual(['--list', '--verbose'])
    expect(out.code).toBe(0)
    expect(out.stdout).toContain('* Ubuntu')
    expect(out.stdout).toContain('AtomicChat')
    expect(out.stdout).not.toContain(String.fromCharCode(0))
  })
})

describe('createWsl — holding a distribution', () => {
  it('starts an attached `sleep infinity` in the distribution and reports its end when the VM stops', async () => {
    const hold = wsl.distribution('AtomicChat').hold()
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(calls().at(-1)?.argv).toEqual(['-d', 'AtomicChat', '--exec', 'sleep', 'infinity'])

    // `wsl --shutdown` from anywhere: the hold process ends, and the core learns of it.
    await wsl.command(['--shutdown'])
    const end = await hold.exited
    expect(end.released).toBe(false)
    hold.release()
  })

  it('release() stops the hold, and `exited` says the core let go itself', async () => {
    const hold = wsl.distribution('AtomicChat').hold()
    await new Promise((resolve) => setTimeout(resolve, 200))
    hold.release()
    const end = await hold.exited
    expect(end.released).toBe(true)
  })

  it('a hold whose executable is missing ends at once, not released', async () => {
    const hold = createWsl({ executable: join(dir, 'no-such-wsl.exe') })
      .distribution('AtomicChat')
      .hold()
    const end = await hold.exited
    expect(end.released).toBe(false)
    expect(end.code).toBeNull()
  })
})

describe('decodeWslBytes', () => {
  it.each([
    [
      'UTF-16LE with a BOM',
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('NAME  STATE\r\n', 'utf16le')]),
      'NAME  STATE\r\n',
    ],
    ['UTF-16LE without a BOM', Buffer.from('Default Version: 2\r\n', 'utf16le'), 'Default Version: 2\r\n'],
    ['UTF-8 Cyrillic', Buffer.from('Версия WSL: 2.4.4.0\n', 'utf8'), 'Версия WSL: 2.4.4.0\n'],
    ['UTF-16LE Cyrillic', Buffer.from('Версия WSL: 2.4.4.0\r\n', 'utf16le'), 'Версия WSL: 2.4.4.0\r\n'],
    ['plain ASCII', Buffer.from('ok\n', 'utf8'), 'ok\n'],
    ['empty', Buffer.alloc(0), ''],
  ])('decodes %s', (_label, bytes, text) => {
    expect(decodeWslBytes(bytes)).toBe(text)
  })
})

describe('defaultWslExecutable', () => {
  it.each([
    [{ SystemRoot: 'C:\\Windows' }, 'C:\\Windows\\System32\\wsl.exe'],
    [{ SYSTEMROOT: 'D:\\WINDOWS' }, 'D:\\WINDOWS\\System32\\wsl.exe'],
    [{}, 'C:\\Windows\\System32\\wsl.exe'],
  ])('resolves the system wsl.exe from %j, never from PATH', (env, path) => {
    expect(defaultWslExecutable(env)).toBe(path)
  })
})
