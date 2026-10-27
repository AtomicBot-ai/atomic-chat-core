import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ATOMIC_MANAGED_BEGIN,
  ATOMIC_MANAGED_END,
  canonicalJson,
  canonicalYaml,
  expandTilde,
  keyOr,
  nodeConfigFs,
  parseJsonLenient,
  parseJsonStrict,
  parseYaml,
  renderMarkedEnvBlock,
  shellRcFile,
  stripAtomicManagedBlock,
  stripJsonComments,
  tomlBasicStringEscape,
  writeMarkedEnvToShell,
} from './config-io.js'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})
async function home(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'atomic-config-io-'))
  dirs.push(dir)
  return dir
}

describe('canonicalJson', () => {
  it('sorts object keys recursively, as serde_json does, and ends with a newline', () => {
    expect(canonicalJson({ b: 1, a: { d: true, c: 'x' } })).toBe(
      '{\n  "a": {\n    "c": "x",\n    "d": true\n  },\n  "b": 1\n}\n'
    )
  })

  it('leaves array order alone and renders empty containers inline', () => {
    expect(canonicalJson({ list: ['b', 'a'], empty: {}, none: [] })).toBe(
      '{\n  "empty": {},\n  "list": [\n    "b",\n    "a"\n  ],\n  "none": []\n}\n'
    )
  })

  it('drops undefined members and writes null for a non-finite number', () => {
    expect(canonicalJson({ a: undefined, b: Number.NaN, c: null })).toBe('{\n  "b": null,\n  "c": null\n}\n')
  })
})

describe('JSON parsing', () => {
  it('treats an empty or whitespace-only file as an empty object', () => {
    expect(parseJsonStrict('', 'x')).toEqual({})
    expect(parseJsonStrict('   \n', 'x')).toEqual({})
    expect(parseJsonLenient('', 'x')).toEqual({})
  })

  it('accepts comments and trailing commas only in the lenient reader', () => {
    const text = '{\n  // a comment\n  "a": 1, /* inline */\n  "b": [1, 2,],\n}'
    expect(parseJsonLenient(text, 'x')).toEqual({ a: 1, b: [1, 2] })
    expect(() => parseJsonStrict(text, 'kilo.jsonc')).toThrow(/Failed to parse kilo.jsonc/)
  })

  it('never treats comment-like text inside a string as a comment', () => {
    expect(stripJsonComments('{"url": "http://x/y", "note": "a /* b */ c"}')).toBe(
      '{"url": "http://x/y", "note": "a /* b */ c"}'
    )
    expect(parseJsonLenient('{"esc": "a\\"//b"}', 'x')).toEqual({ esc: 'a"//b' })
  })

  it('reports a broken file as IO_ERROR naming the path', () => {
    expect(() => parseJsonStrict('{oops', 'settings.json')).toThrow(/settings.json/)
    expect(() => parseJsonLenient('{oops', 'settings.json')).toThrowError(
      expect.objectContaining({ code: 'IO_ERROR' })
    )
  })
})

describe('YAML', () => {
  it('writes sequences at the parent indent, the way serde_yaml 0.9 does', () => {
    expect(canonicalYaml({ models: [{ id: 'a' }, { id: 'b' }] })).toBe('models:\n- id: a\n- id: b\n')
    expect(parseYaml('models:\n- id: a\n', 'x')).toEqual({ models: [{ id: 'a' }] })
    expect(parseYaml('', 'x')).toEqual({})
    expect(() => parseYaml('a: [unclosed', 'settings.yaml')).toThrow(/settings.yaml/)
  })
})

describe('managed blocks', () => {
  it('strips every block and leaves the newline after the marker, as Rust does', () => {
    const text = `head\n${ATOMIC_MANAGED_BEGIN}\nx = 1\n${ATOMIC_MANAGED_END}\nmiddle\n${ATOMIC_MANAGED_BEGIN}\ny = 2\n${ATOMIC_MANAGED_END}\ntail\n`
    expect(stripAtomicManagedBlock(text)).toBe('head\n\nmiddle\n\ntail\n')
    expect(stripAtomicManagedBlock('nothing here')).toBe('nothing here')
    // A closing marker before an opening one is not a block.
    expect(stripAtomicManagedBlock(`${ATOMIC_MANAGED_END}\n${ATOMIC_MANAGED_BEGIN}`)).toContain(
      ATOMIC_MANAGED_END
    )
  })
})

describe('shell rc selection', () => {
  it('picks bash_profile on macOS, bashrc on Linux, zshenv otherwise', () => {
    expect(shellRcFile('/bin/bash', 'darwin')).toBe('.bash_profile')
    expect(shellRcFile('/usr/bin/bash', 'linux')).toBe('.bashrc')
    expect(shellRcFile('/bin/zsh', 'darwin')).toBe('.zshenv')
    expect(shellRcFile('/usr/bin/fish', 'linux')).toBe('.zshenv')
    expect(shellRcFile(undefined, 'darwin')).toBe('.zshenv')
  })
})

describe('renderMarkedEnvBlock', () => {
  // Each env-var agent owns a one-line marker that both opens and closes its region, so two agents
  // writing the same rc file never eat each other's block.
  const MARKER = '# Atomic Chat - Goose Config'

  it('writes the block alone into an empty file, blank line before the closing marker included', () => {
    expect(renderMarkedEnvBlock('', MARKER, 'GOOSE_', [{ key: 'GOOSE_MODEL', value: 'm' }])).toBe(
      `${MARKER}\nexport GOOSE_MODEL='m'\n\n${MARKER}\n`
    )
  })

  it('replaces our block and keeps unrelated lines', () => {
    const existing = `export PATH=/x\n${MARKER}\nexport GOOSE_MODEL='old'\n\n${MARKER}\nalias l=ls\n`
    expect(renderMarkedEnvBlock(existing, MARKER, 'GOOSE_', [{ key: 'GOOSE_MODEL', value: 'new' }])).toBe(
      `export PATH=/x\nalias l=ls\n${MARKER}\nexport GOOSE_MODEL='new'\n\n${MARKER}\n`
    )
  })

  it('removes a managed variable that does not share the prefix, because the whole region goes', () => {
    // Goose writes OPENAI_* inside its GOOSE_ block; only block removal makes a rerun idempotent.
    const existing = `${MARKER}\nexport OPENAI_HOST='old'\n\n${MARKER}\n`
    const result = renderMarkedEnvBlock(existing, MARKER, 'GOOSE_', [{ key: 'OPENAI_HOST', value: 'new' }])
    expect(result).toBe(`${MARKER}\nexport OPENAI_HOST='new'\n\n${MARKER}\n`)
  })

  it('also drops a hand-written export with our prefix, which would otherwise win', () => {
    const existing = "export GOOSE_MODEL='theirs'\nexport OPENAI_API_KEY='theirs'\n"
    const result = renderMarkedEnvBlock(existing, MARKER, 'GOOSE_', [{ key: 'GOOSE_MODEL', value: 'ours' }])
    expect(result).not.toContain("export GOOSE_MODEL='theirs'")
    expect(result, "a key outside our prefix is the user's business").toContain(
      "export OPENAI_API_KEY='theirs'"
    )
  })

  it('writes values in single quotes without escaping them', () => {
    expect(renderMarkedEnvBlock('', MARKER, 'X_', [{ key: 'X_A', value: 'a b' }])).toContain(
      "export X_A='a b'"
    )
  })
})

describe('nodeConfigFs', () => {
  it('reads, writes through a temp file, creates parents and reports existence', async () => {
    const root = await home()
    const fs = nodeConfigFs(root)
    expect(await fs.read('.config/app/config.json')).toBeUndefined()
    expect(await fs.exists('.config/app/config.json')).toBe(false)

    await fs.write('.config/app/config.json', '{"a":1}\n')
    expect(await fs.read('.config/app/config.json')).toBe('{"a":1}\n')
    expect(await fs.exists('.config/app/config.json')).toBe(true)
    expect(fs.absolute('.config/app/config.json')).toBe(join(root, '.config/app/config.json'))
    expect(await readFile(join(root, '.config/app/config.json'), 'utf8')).toBe('{"a":1}\n')

    await fs.write('.secret', 'x', { mode: 0o600 })
    if (process.platform !== 'win32') {
      expect((await stat(join(root, '.secret'))).mode & 0o777).toBe(0o600)
    }
    await fs.remove('.secret')
    expect(await fs.exists('.secret')).toBe(false)
    await fs.mkdirp('.config/nested/deep')
    expect(await fs.exists('.config/nested/deep')).toBe(true)
  })

  it('applies a requested mode exactly, whatever the umask or a stale temp file left behind', async () => {
    const root = await home()
    const fs = nodeConfigFs(root)
    // A temp file from a crashed run keeps its own mode when `writeFile` reuses it.
    await writeFile(join(root, 'shared.toml.atomic-tmp'), 'stale', { mode: 0o644 })
    await fs.write('shared.toml', 'x = 1\n', { mode: 0o660 })
    expect(await readFile(join(root, 'shared.toml'), 'utf8')).toBe('x = 1\n')
    await expect(stat(join(root, 'shared.toml.atomic-tmp'))).rejects.toMatchObject({ code: 'ENOENT' })
    if (process.platform !== 'win32') expect((await stat(join(root, 'shared.toml'))).mode & 0o777).toBe(0o660)
  })

  it('reads strictly: only a missing file is absent, and the bytes come back exactly', async () => {
    const root = await home()
    const fs = nodeConfigFs(root)
    expect(await fs.readStrict('missing.toml')).toBeUndefined()

    // A byte-order mark is content: dropping it would change the bytes a backup is made of.
    await writeFile(join(root, 'bom.toml'), Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x0d, 0x0a]))
    expect(await fs.readStrict('bom.toml')).toBe('\ufeffa\r\n')

    await writeFile(join(root, 'latin1.toml'), Buffer.from([0x61, 0xe9, 0x0a]))
    expect(await fs.read('latin1.toml'), 'the lenient read decodes lossily').toBe('a\ufffd\n')
    await expect(fs.readStrict('latin1.toml'), 'not UTF-8 is an error, not text').rejects.toThrow()

    await mkdir(join(root, 'a-directory'))
    expect(await fs.read('a-directory'), 'the lenient read calls any failure absent').toBeUndefined()
    await expect(fs.readStrict('a-directory')).rejects.toMatchObject({ code: 'EISDIR' })
  })

  it('creates a file only when nothing is there, and never overwrites', async () => {
    const root = await home()
    const fs = nodeConfigFs(root)
    expect(await fs.createNew('nested/backup', 'first\n', { mode: 0o600 })).toBe(true)
    expect(await fs.createNew('nested/backup', 'second\n')).toBe(false)
    expect(await readFile(join(root, 'nested/backup'), 'utf8')).toBe('first\n')
    if (process.platform !== 'win32')
      expect((await stat(join(root, 'nested/backup'))).mode & 0o777).toBe(0o600)
    expect(await fs.createNew('plain', 'x')).toBe(true)
  })

  // Root writes into a read-only directory anyway; Windows has no such directory mode.
  const canLockDirs = process.platform !== 'win32' && process.getuid?.() !== 0
  it.skipIf(!canLockDirs)('throws when a file cannot be created at all', async () => {
    const root = await home()
    const fs = nodeConfigFs(root)
    await mkdir(join(root, 'locked'))
    await chmod(join(root, 'locked'), 0o500)
    try {
      await expect(fs.createNew('locked/backup', 'x')).rejects.toMatchObject({ code: 'EACCES' })
    } finally {
      await chmod(join(root, 'locked'), 0o700)
    }
    expect(await fs.exists('locked/backup')).toBe(false)
  })

  it('reports permission bits, absent for a missing file and an error for an unreachable one', async () => {
    const root = await home()
    const fs = nodeConfigFs(root)
    await writeFile(join(root, 'config.toml'), '')
    await chmod(join(root, 'config.toml'), 0o640)
    expect(await fs.permissions('missing.toml')).toBeUndefined()
    if (process.platform === 'win32') return
    expect(await fs.permissions('config.toml')).toBe(0o640)
    await expect(fs.permissions('config.toml/inside')).rejects.toMatchObject({ code: 'ENOTDIR' })
  })

  it('writes the env block into the rc file the shell implies', async () => {
    const root = await home()
    const fs = nodeConfigFs(root)
    await writeFile(join(root, '.zshenv'), 'export PATH=/x\n')
    await writeMarkedEnvToShell(fs, '/bin/zsh', 'darwin', '# Atomic Chat - OpenHands Config', 'LLM_', [
      { key: 'LLM_MODEL', value: 'openai/m' },
    ])
    const rc = await fs.read('.zshenv')
    expect(rc).toContain('export PATH=/x')
    expect(rc).toContain("export LLM_MODEL='openai/m'")
    expect(await fs.exists('.bash_profile')).toBe(false)
  })
})

describe('small helpers', () => {
  it('escapes everything a TOML basic string forbids raw, and falls back for an empty key', () => {
    expect(tomlBasicStringEscape('a"b\\c')).toBe('a\\"b\\\\c')
    expect(tomlBasicStringEscape("it's fine")).toBe("it's fine")
    expect(tomlBasicStringEscape('\b\t\n\f\r')).toBe('\\b\\t\\n\\f\\r')
    // The other control characters and DEL have no short form: four upper-case hex digits.
    expect(tomlBasicStringEscape('\u0000\u0001\u001b\u001f\u007f')).toBe(
      '\\u0000\\u0001\\u001B\\u001F\\u007F'
    )
    expect(tomlBasicStringEscape(' ~é€😀')).toBe(' ~é€😀')
    expect(keyOr('', 'atomic')).toBe('atomic')
    expect(keyOr('k', 'atomic')).toBe('k')
  })

  it('expands a leading tilde only', () => {
    expect(expandTilde('~', '/home/u')).toBe('/home/u')
    // `resolve`, like the code: on Windows it also puts the current drive in front.
    expect(expandTilde('~/.dsh', '/home/u')).toBe(resolve('/home/u', '.dsh'))
    expect(expandTilde('/abs/path', '/home/u')).toBe('/abs/path')
    expect(expandTilde('relative/~', '/home/u')).toBe('relative/~')
  })
})
