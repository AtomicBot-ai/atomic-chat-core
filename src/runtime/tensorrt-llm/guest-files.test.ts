import { describe, expect, it } from 'vitest'
import type { WslDistributionTransport } from '../wsl/index.js'
import { guestModelFiles } from './guest-files.js'

const UNC = (path: string) => `\\\\wsl.localhost\\AtomicChat${path.replaceAll('/', '\\')}`
const scope = '/var/lib/atomic-chat/scopes/k1'

const guest = (du: { code: number; stdout: string; stderr?: string }) => {
  const calls: string[][] = []
  const transport: WslDistributionTransport = {
    name: 'AtomicChat',
    exec: async (argv) => {
      calls.push(argv)
      return argv[0] === 'du'
        ? { code: du.code, stdout: du.stdout, stderr: du.stderr ?? '' }
        : { code: 0, stdout: '', stderr: '' }
    },
    hold: () => {
      throw new Error('no hold')
    },
  }
  return { transport, calls }
}

describe('guestModelFiles', () => {
  it('sizes every path in one du call in the guest — a hard link counted once — and maps the answer back', async () => {
    const g = guest({
      code: 0,
      stdout: `1000\t${scope}/models/tensorrt-llm/acme/m\n300\t${scope}/caches/r1/acme%2Fm\n`,
    })
    const files = guestModelFiles(g.transport)
    const sizes = await files.sizes([
      UNC(`${scope}/models/tensorrt-llm/acme/m`),
      UNC(`${scope}/caches/r1/acme%2Fm`),
    ])
    expect(g.calls).toEqual([
      ['du', '-s', '-b', '--', `${scope}/models/tensorrt-llm/acme/m`, `${scope}/caches/r1/acme%2Fm`],
    ])
    expect([...sizes.values()]).toEqual([1000, 300])
  })

  it('a path du could not find counts as zero, the others as they are', async () => {
    const g = guest({
      code: 1,
      stdout: `1000\t${scope}/models/tensorrt-llm/acme/m\n`,
      stderr: 'du: cannot access',
    })
    const sizes = await guestModelFiles(g.transport).sizes([
      UNC(`${scope}/models/tensorrt-llm/acme/m`),
      UNC(`${scope}/caches/x`),
    ])
    expect([...sizes.values()]).toEqual([1000, 0])
  })

  it('removes with one rm -rf in the guest, never through \\\\wsl.localhost', async () => {
    const g = guest({ code: 0, stdout: '' })
    await guestModelFiles(g.transport).remove([
      UNC(`${scope}/caches/r1`),
      UNC(`${scope}/models/tensorrt-llm/acme/m`),
    ])
    expect(g.calls).toEqual([
      ['rm', '-rf', '--', `${scope}/caches/r1`, `${scope}/models/tensorrt-llm/acme/m`],
    ])
  })

  it('refuses a path outside the distribution', async () => {
    await expect(
      guestModelFiles(guest({ code: 0, stdout: '' }).transport).remove(['C:\\Windows'])
    ).rejects.toThrow()
  })
})
