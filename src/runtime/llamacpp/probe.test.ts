import { describe, expect, it } from 'vitest'
import { checkSpecTypeSupport, DFLASH_SPEC_TYPE } from './probe.js'

const node = (script: string) => ({ exe: process.execPath, args: ['-e', script] })

describe('checkSpecTypeSupport', () => {
  it('finds the spec type in stdout or stderr of `-h`', async () => {
    const yes = node('console.log("usage: ... --spec-type {draft-dflash,draft-mtp}")')
    const spawn = () => spawnHelp(yes)
    expect(await checkSpecTypeSupport('/x', DFLASH_SPEC_TYPE, {}, undefined, { spawn })).toBe(true)
    const no = node('console.error("usage: ... --spec-type {draft-mtp}")')
    expect(
      await checkSpecTypeSupport('/x', DFLASH_SPEC_TYPE, {}, undefined, { spawn: () => spawnHelp(no) })
    ).toBe(false)
  })
  it('times out and fails when the binary cannot be started', async () => {
    const hang = node('setInterval(()=>{},1000)')
    await expect(
      checkSpecTypeSupport('/x', DFLASH_SPEC_TYPE, {}, undefined, {
        spawn: () => spawnHelp(hang),
        timeoutMs: 200,
      })
    ).rejects.toMatchObject({ code: 'MODEL_LOAD_TIMED_OUT' })
    await expect(
      checkSpecTypeSupport('/definitely/missing', DFLASH_SPEC_TYPE, {}, undefined)
    ).rejects.toMatchObject({
      code: 'MODEL_LOAD_FAILED',
    })
  })
})

const spawnModule = await import('../shared/index.js')
const spawnHelp = (spec: { exe: string; args: string[] }) =>
  spawnModule.spawnManaged({
    exe: spec.exe,
    args: spec.args,
    env: { ...process.env } as Record<string, string>,
  })
