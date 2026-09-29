import { describe, expect, it } from 'vitest'
import type { DockerExec } from '../container/index.js'
import type { HostExec } from '../environment/index.js'
import {
  NVIDIA_SMI_GPU_QUERY,
  PROC_MEMINFO_PATH,
  parseMemAvailableBytes,
  probeTensorrtLlmGpus,
  probeTensorrtLlmGpusAndMemory,
  probeTensorrtLlmHost,
  readMemAvailableBytes,
} from './host-facts.js'

const SMI =
  'GPU-aaaa, NVIDIA RTX 4090, 8.9, 24564, 24000, 581.42\n' +
  'GPU-bbbb, NVIDIA RTX PRO 6000, 12.0, 97887, 97000, 581.42\n'

const MEMINFO = 'MemTotal:       132000000 kB\nMemFree:        20000000 kB\nMemAvailable:   65536000 kB\n'

function fakes(info: { code: number | null; stdout: string }, meminfo: string | null = MEMINFO) {
  const calls: Array<{ command: string; args: string[] }> = []
  const exec: HostExec = async (command, args) => {
    calls.push({ command, args })
    return { code: 0, stdout: SMI, stderr: '' }
  }
  const docker: DockerExec = async (args) => {
    calls.push({ command: 'docker', args })
    return { ...info, stderr: '' }
  }
  const readFile = async (path: string): Promise<string | null> =>
    path === PROC_MEMINFO_PATH ? meminfo : null
  return { calls, exec, docker, readFile }
}

describe('probeTensorrtLlmHost', () => {
  it('reads the cards from nvidia-smi, SELinux from docker info over the system socket, and MemAvailable', async () => {
    const { calls, exec, docker, readFile } = fakes({
      code: 0,
      stdout: JSON.stringify({ ServerVersion: '28.1.1', SecurityOptions: ['name=seccomp', 'name=selinux'] }),
    })
    const facts = await probeTensorrtLlmHost({ exec, docker, nvidiaSmi: '/opt/bin/nvidia-smi', readFile })
    expect(facts.selinux).toBe(true)
    expect(facts.memAvailableBytes).toBe(65_536_000 * 1024)
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
    const { exec, docker, readFile } = fakes(info)
    await expect(
      probeTensorrtLlmHost({ exec, docker, nvidiaSmi: 'nvidia-smi', readFile })
    ).rejects.toMatchObject({
      code: 'MANAGED_PREREQUISITE_BLOCKED',
      message: expect.stringContaining('SELinux'),
    })
  })

  it('reads SELinux as off only when docker info answers and lists no SELinux option', async () => {
    const { exec, docker, readFile } = fakes({
      code: 0,
      stdout: JSON.stringify({ ServerVersion: '28.1.1', SecurityOptions: [] }),
    })
    expect((await probeTensorrtLlmHost({ exec, docker, nvidiaSmi: 'nvidia-smi', readFile })).selinux).toBe(
      false
    )
  })

  it('reports memAvailableBytes as 0 when /proc/meminfo cannot be read, without failing the whole probe', async () => {
    const { exec, docker, readFile } = fakes(
      { code: 0, stdout: JSON.stringify({ ServerVersion: '28.1.1', SecurityOptions: [] }) },
      null
    )
    const facts = await probeTensorrtLlmHost({ exec, docker, nvidiaSmi: 'nvidia-smi', readFile })
    expect(facts.memAvailableBytes).toBe(0)
  })
})

describe('probeTensorrtLlmGpus', () => {
  it('reads just the cards, with no Docker dependency at all', async () => {
    const { exec } = fakes({ code: 0, stdout: '{}' })
    const gpus = await probeTensorrtLlmGpus({ exec, nvidiaSmi: 'nvidia-smi' })
    expect(gpus.map((g) => g.gpu_id)).toEqual(['GPU-aaaa', 'GPU-bbbb'])
  })
})

describe('probeTensorrtLlmGpusAndMemory', () => {
  it('answers gpus and memAvailableBytes without ever calling Docker, even when docker info would refuse', async () => {
    const { exec, readFile } = fakes({ code: null, stdout: '' })
    const result = await probeTensorrtLlmGpusAndMemory({ exec, nvidiaSmi: 'nvidia-smi', readFile })
    expect(result.gpus.map((g) => g.gpu_id)).toEqual(['GPU-aaaa', 'GPU-bbbb'])
    expect(result.memAvailableBytes).toBe(65_536_000 * 1024)
  })
})

describe('readMemAvailableBytes', () => {
  it('reads MemAvailable in bytes', async () => {
    expect(await readMemAvailableBytes({ readFile: async () => MEMINFO })).toBe(65_536_000 * 1024)
  })

  it('is 0 when the file cannot be read', async () => {
    expect(await readMemAvailableBytes({ readFile: async () => null })).toBe(0)
  })

  it('is 0 when the file has no MemAvailable line', async () => {
    expect(await readMemAvailableBytes({ readFile: async () => 'MemTotal: 100 kB\n' })).toBe(0)
  })
})

describe('parseMemAvailableBytes', () => {
  it('parses the MemAvailable line into bytes', () => {
    expect(parseMemAvailableBytes(MEMINFO)).toBe(65_536_000 * 1024)
  })

  it('is tolerant of the line appearing anywhere, and extra whitespace', () => {
    expect(parseMemAvailableBytes('Foo: 1\nMemAvailable:    12345   kB\nBar: 2\n')).toBe(12_345 * 1024)
  })

  it('is null when there is no MemAvailable line', () => {
    expect(parseMemAvailableBytes('MemTotal: 100 kB\n')).toBeNull()
  })

  it('is null for an empty document', () => {
    expect(parseMemAvailableBytes('')).toBeNull()
  })

  it('is null for a value so large it parses to a non-finite number', () => {
    expect(parseMemAvailableBytes(`MemAvailable: ${'9'.repeat(400)} kB\n`)).toBeNull()
  })
})
