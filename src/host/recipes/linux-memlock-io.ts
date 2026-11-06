import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { LinuxMemlockStepParameters } from '../../contracts/index.js'
import { RUNTIME_MEMLOCK, runtimeProcess } from '../../runtime/fastflowlm/environment/index.js'
import type { HostStepExecutorDeps } from './executor.js'
import { npuCommandEnv } from './linux-npu-dpkg.js'

const native = {
  run: async (exe: string, args: string[]) => {
    const { stdout } = await promisify(execFile)(exe, args, {
      cwd: '/',
      env: npuCommandEnv,
      timeout: 30000,
      maxBuffer: 65536,
    })
    return stdout.trimEnd()
  },
}
type Deps = Pick<HostStepExecutorDeps, 'invokingUid' | 'readFile' | 'writeFile'>
/** No packages, kernel assumptions, capabilities on the application, or server restart. */
export async function configureRuntimeMemlock(t: LinuxMemlockStepParameters, deps: Deps, io = native) {
  const run = io.run,
    read = async (p: string) =>
      Buffer.from((await deps.readFile(p)) ?? [])
        .toString()
        .trim()
  const user = (await run('/usr/bin/getent', ['passwd', t.runtime_account])).split(':')
  const uid = user[2],
    home = user[5]
  if (
    user[0] !== t.runtime_account ||
    !uid ||
    !/^[1-9]\d*$/.test(uid) ||
    !home?.startsWith('/') ||
    (t.runtime_mode !== 'system-service' && deps.invokingUid !== null && deps.invokingUid !== uid)
  )
    throw Error('Runtime account does not match the operator.')
  const identity = async (pid: number) => {
    const p = runtimeProcess(
      await read('/proc/' + pid + '/stat'),
      await read('/proc/sys/kernel/random/boot_id')
    )
    const owners = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/m.exec(await read('/proc/' + pid + '/status'))
    if (!p || !owners || owners.slice(1).some((v) => v !== uid)) throw Error('Runtime process owner changed.')
    return p
  }
  const expected = t.runtime_process
  const check = async () => {
    if (JSON.stringify(await identity(expected.pid)) !== JSON.stringify(expected))
      throw Error('Runtime process changed after approval.')
  }
  await check()
  const asUser = (exe: string, ...args: string[]) =>
    run('/usr/sbin/runuser', [
      '-u',
      t.runtime_account,
      '--',
      '/usr/bin/env',
      '-i',
      'HOME=' + home,
      'PATH=/usr/bin:/bin',
      'XDG_RUNTIME_DIR=/run/user/' + uid,
      exe,
      ...args,
    ])
  const show = (unit: string, prop: string, userScope = false) =>
    userScope
      ? asUser('/usr/bin/systemctl', '--user', 'show', unit, '--property=' + prop, '--value')
      : run('/usr/bin/systemctl', ['show', unit, '--property=' + prop, '--value'])
  const unit = t.runtime_service,
    userScope = t.runtime_mode === 'user-service'
  let manager: Awaited<ReturnType<typeof identity>> | undefined
  if (unit) {
    if (
      (!userScope && (await show(unit, 'User')) !== t.runtime_account) ||
      (await show(unit, 'MainPID', userScope)) !== String(expected.pid)
    )
      throw Error('Service does not own the approved runtime process.')
    if (userScope) {
      const pid = Number(await show('user@' + uid + '.service', 'MainPID'))
      if (!Number.isSafeInteger(pid) || pid <= 1) throw Error('User manager is unavailable.')
      manager = await identity(pid)
    }
  }
  const sufficient = (v: string) => v === 'unlimited' || BigInt(v) >= BigInt(RUNTIME_MEMLOCK.bytes)
  const limitsFor = async (pid: number) => {
    const values = /^Max locked memory\s+(unlimited|\d+)\s+(unlimited|\d+)\s+bytes[ \t]*$/m.exec(
      await read('/proc/' + pid + '/limits')
    )
    if (!values) throw Error('Cannot read the runtime locked-memory limit.')
    return { soft: values[1]!, hard: values[2]! }
  }
  const maximum = (a: string, b: string) =>
    a === 'unlimited' || b === 'unlimited'
      ? 'unlimited'
      : String(BigInt(a) > BigInt(b) ? BigInt(a) : BigInt(b))
  let savedHard = maximum((await limitsFor(expected.pid)).hard, RUNTIME_MEMLOCK.bytes)
  if (manager) savedHard = maximum(savedHard, (await limitsFor(manager.pid)).hard)
  const raise = async (p: typeof expected) => {
    if (JSON.stringify(await identity(p.pid)) !== JSON.stringify(p))
      throw Error('Process changed before applying its limit.')
    const limits = await limitsFor(p.pid)
    const hard = maximum(limits.hard, savedHard)
    if (!sufficient(limits.soft) || hard !== limits.hard) {
      const soft = maximum(limits.soft, RUNTIME_MEMLOCK.bytes)
      await run('/usr/bin/prlimit', ['--pid', String(p.pid), '--memlock=' + soft + ':' + hard])
    }
    if (JSON.stringify(await identity(p.pid)) !== JSON.stringify(p))
      throw Error('Process exited while applying its limit.')
    const soft = /^Max locked memory\s+(unlimited|\d+)\s+/m.exec(
      await read('/proc/' + p.pid + '/limits')
    )?.[1]
    if (!soft || !sufficient(soft)) throw Error('Runtime locked-memory limit did not take effect.')
  }
  const persist = (path: string, text: string) => deps.writeFile(path, Buffer.from(text), 0o644)
  const limit =
    '[Service]\nLimitMEMLOCK=' +
    RUNTIME_MEMLOCK.bytes +
    (savedHard === RUNTIME_MEMLOCK.bytes ? '' : ':' + (savedHard === 'unlimited' ? 'infinity' : savedHard)) +
    '\n'
  if (unit && !userScope) {
    await persist('/etc/systemd/system/' + unit + '.d/60-atomic-memlock.conf', limit)
    await run('/usr/bin/systemctl', ['daemon-reload'])
  } else {
    await persist(
      '/etc/security/limits.d/90-atomic-memlock-' + uid + '.conf',
      t.runtime_account +
        ' soft memlock 2097152\n' +
        t.runtime_account +
        ' hard memlock ' +
        (savedHard === 'unlimited' ? '-1' : String(BigInt(savedHard) / 1024n)) +
        '\n'
    )
    if (unit && manager) {
      await persist('/etc/systemd/system/user@' + uid + '.service.d/60-atomic-memlock.conf', limit)
      const stage = '/run/atomic-memlock-' + uid + '-' + unit + '.conf'
      await persist(stage, limit)
      try {
        await asUser(
          '/usr/bin/install',
          '-D',
          '-m',
          '0644',
          stage,
          home + '/.config/systemd/user/' + unit + '.d/60-atomic-memlock.conf'
        )
      } finally {
        await run('/usr/bin/rm', ['--', stage])
      }
      await run('/usr/bin/systemctl', ['daemon-reload'])
      await asUser('/usr/bin/systemctl', '--user', 'daemon-reload')
      await raise(manager)
    }
  }
  await check()
  await raise(expected)
}
