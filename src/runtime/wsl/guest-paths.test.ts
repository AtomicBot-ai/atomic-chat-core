import { describe, expect, it } from 'vitest'
import { dataLayout } from '../../config/index.js'
import { guestPathFor, guestScopePaths, guestScopeRoot, uncPathFor } from './guest-paths.js'

describe('the guest’s files from Windows', () => {
  it('names a guest path as \\\\wsl.localhost\\<distro>\\…, and back', () => {
    const unc = uncPathFor('AtomicChat', '/var/lib/atomic-chat/scopes/k1/models/tensorrt-llm/m')
    expect(unc).toBe(
      '\\\\wsl.localhost\\AtomicChat\\var\\lib\\atomic-chat\\scopes\\k1\\models\\tensorrt-llm\\m'
    )
    expect(guestPathFor('AtomicChat', unc)).toBe('/var/lib/atomic-chat/scopes/k1/models/tensorrt-llm/m')
  })

  it.each([
    ['\\\\wsl$\\AtomicChat\\var\\lib\\x', '/var/lib/x'],
    ['\\\\WSL.LOCALHOST\\atomicchat\\var\\lib\\x', '/var/lib/x'],
    ['//wsl.localhost/AtomicChat/var/lib/x', '/var/lib/x'],
  ])('reads %s as the guest path %s', (unc, guest) => {
    expect(guestPathFor('AtomicChat', unc)).toBe(guest)
  })

  it.each([
    ['C:\\Users\\ada\\models\\m'],
    ['\\\\wsl.localhost\\Ubuntu\\home\\ada'],
    ['\\\\wsl.localhost\\AtomicChat\\var\\..\\..\\etc'],
    ['\\\\wsl.localhost\\AtomicChatX\\var'],
  ])('refuses %s: not inside our distribution', (path) => {
    expect(() => guestPathFor('AtomicChat', path)).toThrow(/not inside the Atomic Chat distribution/)
  })

  it('keeps one scope’s files under its own key', () => {
    expect(guestScopeRoot('0f3c')).toBe('/var/lib/atomic-chat/scopes/0f3c')
    expect(() => guestScopeRoot('../x')).toThrow()
  })

  it('moves heartbeats, caches and the watchdog into the guest, and keeps the journal and docker config on Windows', () => {
    const windows = dataLayout('C:\\Users\\ada\\AppData\\Roaming\\Atomic Chat\\data').managed
    const paths = guestScopePaths(windows, 'AtomicChat', 'k1')
    const root = '\\\\wsl.localhost\\AtomicChat\\var\\lib\\atomic-chat\\scopes\\k1'
    expect(paths.heartbeatDir('g1').startsWith(`${root}\\heartbeats\\`)).toBe(true)
    expect(paths.engineCacheDir('d1', 'm1').startsWith(`${root}\\caches\\`)).toBe(true)
    expect(paths.watchdogScript).toBe(`${root}\\watchdog\\atomic-watchdog-entrypoint.sh`)
    expect(paths.executionsDir).toBe(windows.executionsDir)
    expect(paths.dockerConfigDir).toBe(windows.dockerConfigDir)
  })
})
