import { describe, expect, it } from 'vitest'
import { identityMountSourceResolver } from './mount-source.js'

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
