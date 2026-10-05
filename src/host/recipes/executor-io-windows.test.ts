import { describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../../contracts/index.js'
import {
  judgeWindowsAcl,
  parseWindowsAcl,
  windowsHostStepDeps,
  type WindowsAcl,
  type WindowsHostStepIo,
} from './executor-io-windows.js'

const USER = 'S-1-5-21-1111-2222-3333-1001'
const OTHER = 'S-1-5-21-1111-2222-3333-1002'
const FULL = 0x1f01ff
const READ = 0x1200a9

/** What the app creates: the user, SYSTEM and Administrators, nobody else. */
const appFolder = (over: Partial<WindowsAcl> = {}): WindowsAcl => ({
  reparse: false,
  directory: true,
  owner: USER,
  rules: [
    { sid: USER, allow: true, rights: FULL },
    { sid: 'S-1-5-18', allow: true, rights: FULL },
    { sid: 'S-1-5-32-544', allow: true, rights: FULL },
  ],
  ...over,
})

describe('judgeWindowsAcl', () => {
  it('trusts the folder the app creates', () => {
    expect(judgeWindowsAcl(appFolder(), 'host-steps', 'directory')).toBeNull()
  })

  it.each([
    ['a junction', appFolder({ reparse: true }), /reparse point/],
    ['a file where the folder should be', appFolder({ directory: false }), /not a directory/],
    ['a folder Everyone owns', appFolder({ owner: 'S-1-1-0' }), /group anyone belongs to/],
    [
      'another account with write access',
      appFolder({ rules: [...appFolder().rules, { sid: OTHER, allow: true, rights: 0x2 }] }),
      /writable by S-1-5-21-1111-2222-3333-1002/,
    ],
    [
      'Users allowed to change permissions',
      appFolder({ rules: [...appFolder().rules, { sid: 'S-1-5-32-545', allow: true, rights: 0x40000 }] }),
      /writable by S-1-5-32-545/,
    ],
    [
      'Authenticated Users with GENERIC_ALL',
      appFolder({ rules: [...appFolder().rules, { sid: 'S-1-5-11', allow: true, rights: 0x10000000 }] }),
      /writable by S-1-5-11/,
    ],
  ])('refuses %s', (_label, acl, why) => {
    expect(judgeWindowsAcl(acl, 'host-steps', 'directory')).toMatch(why)
  })

  it('lets others read, and ignores a deny entry', () => {
    const acl = appFolder({
      rules: [
        ...appFolder().rules,
        { sid: 'S-1-5-32-545', allow: true, rights: READ },
        { sid: OTHER, allow: false, rights: FULL },
      ],
    })
    expect(judgeWindowsAcl(acl, 'host-steps', 'directory')).toBeNull()
  })
})

describe('parseWindowsAcl', () => {
  it('reads one rule PowerShell printed as an object as well as several as an array', () => {
    const one = parseWindowsAcl({
      code: 0,
      stdout: JSON.stringify({
        reparse: false,
        directory: true,
        owner: USER,
        rules: { sid: USER, allow: true, rights: FULL },
      }),
      stderr: '',
    })
    expect(one.rules).toEqual([{ sid: USER, allow: true, rights: FULL }])
  })

  it('throws when PowerShell failed', () => {
    expect(() => parseWindowsAcl({ code: 1, stdout: '', stderr: 'denied' })).toThrow(/Get-Acl failed/)
  })
})

/** An in-memory Windows for the executor's I/O: ACLs by path, files, every command. */
const fakeIo = (acls: Record<string, WindowsAcl>, files: Record<string, string> = {}) => {
  const calls: { command: string; args: string[]; env?: Record<string, string> }[] = []
  const io: WindowsHostStepIo = {
    exec: async (command, args, options) => {
      calls.push({ command, args, ...(options?.env === undefined ? {} : { env: options.env }) })
      if (command.endsWith('powershell.exe')) {
        const acl = acls[options?.env?.['ATOMIC_HOST_STEP_PATH'] ?? '']
        return acl === undefined
          ? { code: 1, stdout: '', stderr: 'no such path' }
          : { code: 0, stdout: JSON.stringify(acl), stderr: '' }
      }
      return { code: 0, stdout: 'ok', stderr: '' }
    },
    lstat: async (path) => ({
      isSymbolicLink: () => false,
      isFile: () => path in files,
      isDirectory: () => !(path in files),
      size: files[path]?.length ?? 0,
    }),
    readFile: async (path) => files[path] ?? '',
    createExclusive: async (path, text) => {
      if (path in files) throw Object.assign(new Error('exists'), { code: 'EEXIST' })
      files[path] = text
    },
    rename: async (from, to) => {
      files[to] = files[from] as string
      delete files[from]
    },
    remove: async (path) => {
      delete files[path]
    },
  }
  return { io, calls, files }
}

const FOLDER = 'C:\\Users\\ada\\AppData\\Local\\AtomicChat\\host-steps'
const REQUEST = `${FOLDER}\\step-1.request.json`
const RESULT = `${FOLDER}\\step-1.result.json`
const fileAcl = appFolder({ directory: false })

describe('windowsHostStepDeps', () => {
  it('reads a request from a trusted folder, and writes the result through a temporary file', async () => {
    const { io, files } = fakeIo({ [FOLDER]: appFolder(), [REQUEST]: fileAcl }, { [REQUEST]: '{"x":1}' })
    const deps = windowsHostStepDeps({ SystemRoot: 'C:\\Windows' }, io)
    expect(await deps.readRequest(REQUEST)).toBe('{"x":1}')
    await deps.writeResult(RESULT, '{"outcome":"completed"}\n')
    expect(files[RESULT]).toBe('{"outcome":"completed"}\n')
    expect(Object.keys(files).filter((path) => path.endsWith('.tmp'))).toEqual([])
  })

  it('refuses a folder another account can write, before reading anything', async () => {
    const open = appFolder({ rules: [...appFolder().rules, { sid: OTHER, allow: true, rights: FULL }] })
    const { io } = fakeIo({ [FOLDER]: open, [REQUEST]: fileAcl }, { [REQUEST]: '{}' })
    await expect(windowsHostStepDeps({}, io).readRequest(REQUEST)).rejects.toBeInstanceOf(AtomicCoreError)
  })

  it('refuses to write a result into a folder that turned into a junction', async () => {
    const { io, files } = fakeIo({ [FOLDER]: appFolder({ reparse: true }) })
    await expect(windowsHostStepDeps({}, io).writeResult(RESULT, '{}')).rejects.toMatchObject({
      code: 'MANAGED_HOST_STEP_INVALID',
    })
    expect(files).toEqual({})
  })

  it('passes the path to PowerShell in the environment, never in the script', async () => {
    const { io, calls } = fakeIo({ [FOLDER]: appFolder(), [REQUEST]: fileAcl }, { [REQUEST]: '{}' })
    await windowsHostStepDeps({}, io).readRequest(REQUEST)
    const query = calls.find((call) => call.command.endsWith('powershell.exe'))
    expect(query?.env).toEqual({ ATOMIC_HOST_STEP_PATH: FOLDER })
    expect(query?.args.join(' ')).not.toContain(FOLDER)
  })

  it('runs only System32\\wsl.exe, with a long deadline for the install', async () => {
    const { io, calls } = fakeIo({})
    const deps = windowsHostStepDeps({ SystemRoot: 'D:\\Win' }, io)
    await deps.exec(['wsl.exe', '--install', '--no-distribution'], { longRunning: true })
    expect(calls.at(-1)).toMatchObject({
      command: 'D:\\Win\\System32\\wsl.exe',
      args: ['--install', '--no-distribution'],
    })
    await expect(deps.exec(['apt-get', 'install', 'docker-ce'])).rejects.toBeInstanceOf(AtomicCoreError)
    await expect(deps.fetch('https://example.test')).rejects.toBeInstanceOf(AtomicCoreError)
  })
})
