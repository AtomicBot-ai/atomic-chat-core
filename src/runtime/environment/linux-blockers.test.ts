import { describe, expect, it } from 'vitest'
import { blocker, installMethodBlocker } from './linux-blockers.js'

describe('blocker', () => {
  it('omits params and commands when neither is given, rather than storing them as undefined', () => {
    expect(blocker('driver-missing', 'No NVIDIA driver was found.')).toEqual({
      reason: 'driver-missing',
      message: 'No NVIDIA driver was found.',
    })
  })

  it('carries params and commands through when given', () => {
    expect(
      blocker('driver-too-old', 'too old', { required: '590', actual: '580' }, ['do this', 'then this'])
    ).toEqual({
      reason: 'driver-too-old',
      message: 'too old',
      params: { required: '590', actual: '580' },
      commands: ['do this', 'then this'],
    })
  })
})

describe('installMethodBlocker', () => {
  it('blocks snap, rootless, Docker Desktop and podman-docker, each with its own reason', () => {
    expect(installMethodBlocker('snap')?.reason).toBe('docker-snap')
    expect(installMethodBlocker('rootless')?.reason).toBe('docker-rootless')
    expect(installMethodBlocker('docker-desktop')?.reason).toBe('docker-desktop-only')
    expect(installMethodBlocker('podman-docker')?.reason).toBe('podman-docker')
  })

  it('says podman-docker must be removed before docker-ce, and that core removes nothing itself', () => {
    const message = installMethodBlocker('podman-docker')?.message ?? ''
    expect(message).toMatch(/removed first/i)
    expect(message).toMatch(/nothing here removes/i)
  })

  it('does not block a recognised distro package or an install this probe never identified', () => {
    expect(installMethodBlocker('docker-ce')).toBeNull()
    expect(installMethodBlocker('moby-engine')).toBeNull()
    expect(installMethodBlocker('docker.io')).toBeNull()
    expect(installMethodBlocker(null)).toBeNull()
  })
})
