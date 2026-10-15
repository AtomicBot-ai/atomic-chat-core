import { describe, expect, it } from 'vitest'
import { parseNpuDevices, probeNpu } from './npu.js'

describe('parseNpuDevices', () => {
  it('reads one device name per line and ignores blank ones', () => {
    expect(
      parseNpuDevices(
        'Intel(R) AI Boost\r\n\r\n  Snapdragon(R) X Elite - X1E80100 - Qualcomm(R) Hexagon(TM) NPU  \n'
      )
    ).toEqual(['Intel(R) AI Boost', 'Snapdragon(R) X Elite - X1E80100 - Qualcomm(R) Hexagon(TM) NPU'])
  })
})

describe('probeNpu', () => {
  const run = (stdout: string, code: number | null = 0) => {
    const calls: Array<{ cmd: string; args: string[] }> = []
    return {
      calls,
      run: async (cmd: string, args: string[]) => {
        calls.push({ cmd, args })
        return { code, stdout, stderr: '' }
      },
    }
  }

  it('asks Windows for compute accelerators and reports what it found', async () => {
    const fake = run('Intel(R) AI Boost\n')
    expect(await probeNpu({ platform: 'win32', run: fake.run })).toEqual({
      present: true,
      devices: ['Intel(R) AI Boost'],
    })
    expect(fake.calls[0]?.cmd).toBe('powershell.exe')
    expect(fake.calls[0]?.args.join(' ')).toContain('ComputeAccelerator')
    expect(await probeNpu({ platform: 'win32', run: run('').run })).toEqual({ present: false, devices: [] })
  })

  it('says unknown when PowerShell fails, and no NPU off Windows without asking', async () => {
    expect(await probeNpu({ platform: 'win32', run: run('', 1).run })).toEqual({ present: null, devices: [] })
    const mac = run('should not run')
    expect(await probeNpu({ platform: 'darwin', run: mac.run })).toEqual({ present: false, devices: [] })
    expect(mac.calls).toEqual([])
  })
})
