import { describe, expect, it } from 'vitest'
import type { WslDistributionTransport, WslExecOptions } from '../wsl/index.js'
import { guestDockerExec, guestRealpath, GUEST_DOCKER_BINARY } from './wsl-exec.js'

const transport = (answer: (argv: string[]) => { code: number | null; stdout: string; stderr: string }) => {
  const calls: { argv: string[]; options: WslExecOptions }[] = []
  const t: WslDistributionTransport = {
    name: 'AtomicChat',
    exec: async (argv, options = {}) => {
      calls.push({ argv, options })
      return answer(argv)
    },
    hold: () => {
      throw new Error('no hold')
    },
  }
  return { t, calls }
}

describe('guestDockerExec', () => {
  it('runs the guest’s own docker CLI as root, by its absolute path, with the call’s deadline', async () => {
    const { t, calls } = transport(() => ({ code: 0, stdout: 'ok', stderr: '' }))
    const exec = guestDockerExec(t)
    expect(await exec(['--host', 'unix:///var/run/docker.sock', 'ps'], { timeoutMs: 15_000 })).toEqual({
      code: 0,
      stdout: 'ok',
      stderr: '',
    })
    expect(calls[0]).toEqual({
      argv: [GUEST_DOCKER_BINARY, '--host', 'unix:///var/run/docker.sock', 'ps'],
      options: { user: 'root', timeoutMs: 15_000 },
    })
  })
})

describe('guestRealpath', () => {
  it('resolves a mount source in the guest’s own filesystem', async () => {
    const { t, calls } = transport(() => ({
      code: 0,
      stdout: '/var/lib/atomic-chat/scopes/k1/caches/d/m\n',
      stderr: '',
    }))
    expect(await guestRealpath(t)('/var/lib/atomic-chat/scopes/k1/caches/d/m')).toBe(
      '/var/lib/atomic-chat/scopes/k1/caches/d/m'
    )
    expect(calls[0]?.argv).toEqual(['realpath', '-e', '--', '/var/lib/atomic-chat/scopes/k1/caches/d/m'])
  })

  it('rejects a path that does not exist in the guest', async () => {
    const { t } = transport(() => ({
      code: 1,
      stdout: '',
      stderr: 'realpath: /x: No such file or directory',
    }))
    await expect(guestRealpath(t)('/x')).rejects.toThrow(/No such file/)
  })
})
