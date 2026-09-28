import { describe, expect, it } from 'vitest'
import type { DockerExec } from '../container/index.js'
import type { HostExec } from '../environment/index.js'
import { NVIDIA_SMI_GPU_QUERY, probeTensorrtLlmHost } from './host-facts.js'

const SMI =
  'GPU-aaaa, NVIDIA RTX 4090, 8.9, 24564, 24000, 581.42\n' +
  'GPU-bbbb, NVIDIA RTX PRO 6000, 12.0, 97887, 97000, 581.42\n'

function fakes(info: { code: number | null; stdout: string }) {
  const calls: Array<{ command: string; args: string[] }> = []
  const exec: HostExec = async (command, args) => {
    calls.push({ command, args })
    return { code: 0, stdout: SMI, stderr: '' }
  }
  const docker: DockerExec = async (args) => {
    calls.push({ command: 'docker', args })
    return { ...info, stderr: '' }
  }
  return { calls, exec, docker }
}

describe('probeTensorrtLlmHost', () => {
  it('reads the cards from nvidia-smi and SELinux from docker info over the system socket', async () => {
    const { calls, exec, docker } = fakes({
      code: 0,
      stdout: JSON.stringify({ ServerVersion: '28.1.1', SecurityOptions: ['name=seccomp', 'name=selinux'] }),
    })
    const facts = await probeTensorrtLlmHost({ exec, docker, nvidiaSmi: '/opt/bin/nvidia-smi' })
    expect(facts.selinux).toBe(true)
    expect(facts.gpus.map((g) => [g.gpu_id, g.total_vram_bytes])).toEqual([
      ['GPU-aaaa', 24564 * 1024 * 1024],
      ['GPU-bbbb', 97887 * 1024 * 1024],
    ])
    expect(calls).toContainEqual({ command: '/opt/bin/nvidia-smi', args: NVIDIA_SMI_GPU_QUERY })
    expect(calls).toContainEqual({
      command: 'docker',
      args: ['--host', 'unix:///var/run/docker.sock', 'info', '--format', '{{json .}}'],
    })
  })

  it.each<[string, { code: number | null; stdout: string }]>([
    ['does not answer', { code: null, stdout: '' }],
    ['fails', { code: 1, stdout: '' }],
    [
      'answers with no daemon behind it',
      { code: 0, stdout: JSON.stringify({ ServerErrors: ['Cannot connect'] }) },
    ],
  ])('refuses the load when docker info %s: unknown SELinux is never read as "off"', async (_label, info) => {
    const { exec, docker } = fakes(info)
    await expect(probeTensorrtLlmHost({ exec, docker, nvidiaSmi: 'nvidia-smi' })).rejects.toMatchObject({
      code: 'MANAGED_PREREQUISITE_BLOCKED',
      message: expect.stringContaining('SELinux'),
    })
  })

  it('reads SELinux as off only when docker info answers and lists no SELinux option', async () => {
    const { exec, docker } = fakes({
      code: 0,
      stdout: JSON.stringify({ ServerVersion: '28.1.1', SecurityOptions: [] }),
    })
    expect((await probeTensorrtLlmHost({ exec, docker, nvidiaSmi: 'nvidia-smi' })).selinux).toBe(false)
  })
})
