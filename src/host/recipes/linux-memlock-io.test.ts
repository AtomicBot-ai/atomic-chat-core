import { expect, it, vi } from 'vitest'
import { configureRuntimeMemlock } from './linux-memlock-io.js'
const boot = '11111111-1111-1111-1111-111111111111'
const stat = '4207 (atc server) S ' + Array(18).fill('0').join(' ') + ' 123456 0'
function lab(mode: 'interactive' | 'system-service' | 'user-service' = 'system-service') {
  const files: Record<string, string> = {
    '/proc/sys/kernel/random/boot_id': boot,
    '/proc/4207/stat': stat,
    '/proc/4207/status': 'Uid:\t1000\t1000\t1000\t1000\n',
    '/proc/4207/limits':
      'Max locked memory         8388608              8388608              bytes     \nMax file locks            unlimited            unlimited            locks',
  }
  const run = vi.fn(async (exe: string, args: string[]): Promise<string> => {
    if (exe.endsWith('/getent')) return 'lex:x:1000:1000:Lex:/home/lex:/bin/bash'
    if (args.includes('--property=User')) return 'lex'
    if (args.includes('--property=MainPID')) return '4207'
    if (exe.endsWith('/prlimit')) files['/proc/4207/limits'] = 'Max locked memory 2147483648 2147483648 bytes'
    return ''
  })
  const writeFile = vi.fn(async () => {})
  const deps = {
    invokingUid: '1000',
    readFile: async (p: string) => (files[p] ? Buffer.from(files[p]) : null),
    writeFile,
  }
  const target = {
    runtime_account: 'lex',
    runtime_mode: mode,
    runtime_service: mode === 'interactive' ? null : 'atc.service',
    runtime_process: { pid: 4207, start_ticks: '123456', boot_id: boot },
  }
  return { files, run, deps, target }
}
it('raises the live owner and persists its system service limit without restarting it', async () => {
  const t = lab()
  await configureRuntimeMemlock(t.target, t.deps, { run: t.run })
  expect(t.run).toHaveBeenCalledWith('/usr/bin/prlimit', ['--pid', '4207', '--memlock=2147483648:2147483648'])
  expect(t.deps.writeFile).toHaveBeenCalledWith(
    '/etc/systemd/system/atc.service.d/60-atomic-memlock.conf',
    Buffer.from('[Service]\nLimitMEMLOCK=2147483648\n'),
    0o644
  )
  expect(t.run.mock.calls.flat(2)).not.toContain('restart')
})
it.each(['owner', 'start', 'boot', 'unit'])('refuses a changed %s before any mutation', async (kind) => {
  const t = lab()
  if (kind === 'owner') t.files['/proc/4207/status'] = 'Uid: 2000 2000 2000 2000'
  if (kind === 'start') t.target.runtime_process.start_ticks = '999'
  if (kind === 'boot') t.target.runtime_process.boot_id = '22222222-2222-2222-2222-222222222222'
  if (kind === 'unit')
    t.run.mockImplementation(async (_exe, args) =>
      args.includes('--property=MainPID')
        ? '999'
        : args.includes('--property=User')
          ? 'lex'
          : 'lex:x:1000:1000:Lex:/home/lex:/bin/bash'
    )
  await expect(configureRuntimeMemlock(t.target, t.deps, { run: t.run })).rejects.toThrow()
  expect(t.deps.writeFile).not.toHaveBeenCalled()
  expect(t.run.mock.calls.some(([exe]) => exe.endsWith('/prlimit'))).toBe(false)
})
it('does not lower an existing larger hard limit', async () => {
  const t = lab()
  t.files['/proc/4207/limits'] = 'Max locked memory 8388608 unlimited bytes'
  await configureRuntimeMemlock(t.target, t.deps, { run: t.run })
  expect(t.run).toHaveBeenCalledWith('/usr/bin/prlimit', ['--pid', '4207', '--memlock=2147483648:unlimited'])
})

it('allows an administrator to authorize the verified system service account', async () => {
  const t = lab()
  t.deps.invokingUid = '2000'
  await expect(configureRuntimeMemlock(t.target, t.deps, { run: t.run })).resolves.toBeUndefined()
})
it('refuses another account for interactive preparation', async () => {
  const t = lab('interactive')
  t.deps.invokingUid = '2000'
  await expect(configureRuntimeMemlock(t.target, t.deps, { run: t.run })).rejects.toThrow('operator')
  expect(t.deps.writeFile).not.toHaveBeenCalled()
})

it('prepares a low-limit user manager and user service in one transaction without restarting either', async () => {
  const t = lab('user-service')
  t.files['/proc/500/stat'] = stat.replace('4207', '500')
  t.files['/proc/500/status'] = t.files['/proc/4207/status']!
  t.files['/proc/500/limits'] = t.files['/proc/4207/limits']!
  t.run.mockImplementation(async (exe, args) => {
    if (exe.endsWith('/getent')) return 'lex:x:1000:1000:Lex:/home/lex:/bin/bash'
    if (args.includes('--property=MainPID')) return args.includes('user@1000.service') ? '500' : '4207'
    if (exe.endsWith('/prlimit'))
      t.files['/proc/' + args[1] + '/limits'] = 'Max locked memory 2147483648 2147483648 bytes'
    return ''
  })
  await configureRuntimeMemlock(t.target, t.deps, { run: t.run })
  expect(t.deps.writeFile).toHaveBeenCalledWith(
    '/etc/systemd/system/user@1000.service.d/60-atomic-memlock.conf',
    expect.any(Buffer),
    0o644
  )
  const install = t.run.mock.calls.find(
    ([exe, args]) => exe.endsWith('/runuser') && args.includes('/usr/bin/install')
  )
  expect(install?.[1]).toContain('/home/lex/.config/systemd/user/atc.service.d/60-atomic-memlock.conf')
  expect(t.run.mock.calls.filter(([exe]) => exe.endsWith('/prlimit')).map(([, args]) => args[1])).toEqual([
    '500',
    '4207',
  ])
  expect(t.run.mock.calls.flat(2)).not.toContain('restart')
})
it('persists future login limits while applying the current interactive owner immediately', async () => {
  const t = lab('interactive')
  await configureRuntimeMemlock(t.target, t.deps, { run: t.run })
  expect(t.deps.writeFile).toHaveBeenCalledWith(
    '/etc/security/limits.d/90-atomic-memlock-1000.conf',
    Buffer.from('lex soft memlock 2097152\nlex hard memlock 2097152\n'),
    0o644
  )
  expect(t.run).toHaveBeenCalledWith('/usr/bin/prlimit', ['--pid', '4207', '--memlock=2147483648:2147483648'])
})
