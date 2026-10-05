import { describe, expect, it } from 'vitest'
import { identityMountSourceResolver, wslMountSourceResolver } from './mount-source.js'

describe('identityMountSourceResolver', () => {
  it('returns the core-visible path unchanged', () => {
    expect(identityMountSourceResolver('/home/user/.atomic-chat/models')).toBe(
      '/home/user/.atomic-chat/models'
    )
  })

  it('does not normalize or alter a Windows-style path either', () => {
    expect(identityMountSourceResolver('C:\\Users\\me\\models')).toBe('C:\\Users\\me\\models')
  })
})

describe('wslMountSourceResolver', () => {
  it('turns what core sees through \\\\wsl.localhost into the path the guest’s Docker mounts', () => {
    const resolve = wslMountSourceResolver('AtomicChat')
    expect(resolve('\\\\wsl.localhost\\AtomicChat\\var\\lib\\atomic-chat\\scopes\\k1\\heartbeats\\g1')).toBe(
      '/var/lib/atomic-chat/scopes/k1/heartbeats/g1'
    )
  })

  it('refuses a Windows path: Docker in the guest must never mount a file over 9p', () => {
    expect(() => wslMountSourceResolver('AtomicChat')('C:\\Users\\ada\\models\\m')).toThrow()
  })
})
