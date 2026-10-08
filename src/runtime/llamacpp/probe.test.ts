import { describe, expect, it } from 'vitest'
import { checkSpecTypeSupport, DFLASH_SPEC_TYPE, probeOutputTail, runHelp } from './probe.js'

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

describe('runHelp', () => {
  it('reports the exit and how long -h took', async () => {
    let t = 1000
    const run = await runHelp('/x', {}, undefined, {
      spawn: () => spawnHelp(node('console.error("boom"); process.exit(3)')),
      now: () => (t += 250),
    })
    expect(run.exit).toEqual({ code: 3, signal: null })
    expect(run.output).toContain('boom')
    expect(run.elapsedMs).toBe(250)
  })
  it('keeps what a hung -h printed in the timeout details', async () => {
    const hang = node('console.log("loading backends"); setInterval(()=>{},1000)')
    await expect(
      runHelp('/x', {}, undefined, { spawn: () => spawnHelp(hang), timeoutMs: 500 })
    ).rejects.toMatchObject({
      code: 'MODEL_LOAD_TIMED_OUT',
      details: expect.stringContaining('output so far: loading backends'),
    })
  })
})

describe('probeOutputTail', () => {
  it('keeps the end of the output on one line', () => {
    expect(probeOutputTail('a\n  b\n')).toBe('a b')
    expect(probeOutputTail('x'.repeat(10) + 'tail', 6)).toBe('…xxtail')
    expect(probeOutputTail('\n \n')).toBe('')
  })
})

const spawnModule = await import('../shared/index.js')
const spawnHelp = (spec: { exe: string; args: string[] }) =>
  spawnModule.spawnManaged({
    exe: spec.exe,
    args: spec.args,
    env: { ...process.env } as Record<string, string>,
  })
