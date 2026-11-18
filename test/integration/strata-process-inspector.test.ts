import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { expect, it } from 'vitest'
import { strataControlPlan } from '../../src/runtime/strata/strata-control-plan.js'
import { StrataProcessInspector } from '../../src/runtime/strata/strata-process-inspector.js'

const bundle = process.env.ATOMIC_TEST_STRATA_TREE

it.skipIf(!bundle)(
  'reads real retained identities and only terminates a child recorded for the profile',
  async () => {
    const scopeDir = await realpath(await mkdtemp(join(tmpdir(), 'strata-inspector-native-')))
    const profile = 'atomic-' + 'a'.repeat(32)
    const options = {
      platform: process.platform,
      bundleDir: bundle!,
      scopeDir,
      ownerPid: process.pid,
      profile,
      env: {},
      python: join(
        bundle!,
        process.platform === 'win32' ? 'control/python/python.exe' : 'control/python/bin/python3'
      ),
    }
    const inspector = new StrataProcessInspector(options)
    const foreign = new StrataProcessInspector({ ...options, profile: 'atomic-' + 'b'.repeat(32) })
    const spec = strataControlPlan(options, { kind: 'status' })
    try {
      await inspector.initialize()
      await foreign.initialize()
      const script = `
import subprocess,sys
sys.path.insert(0,sys.argv[1])
from strata_control.atomic_owner import popen
child=popen('engine',sys.argv[2], [sys.executable,'-I','-B','-c','import time; time.sleep(30)'],
            stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
try:
    print(child.pid,flush=True)
    sys.stdin.read(1)
finally:
    if child.poll() is None: child.kill()
    child.wait(timeout=5)
`
      const launcher = spawn(spec.exe, ['-I', '-B', '-c', script, spec.cwd!, profile], {
        env: spec.env,
        cwd: spec.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      const closed = once(launcher, 'close')
      const lines = createInterface({ input: launcher.stdout })
      try {
        const pid = await Promise.race([
          once(lines, 'line').then(([line]) => Number(line)),
          closed.then(([code]) => {
            throw new Error('Ledger test launcher exited early: ' + String(code))
          }),
        ])
        const snapshot = await inspector.snapshot()
        expect(snapshot.launchComplete).toBe(false)
        expect(snapshot.processes).toEqual([
          { role: 'compute', pid, startId: expect.stringMatching(/^strata:/) },
        ])
        const child = snapshot.processes[0]!
        await expect(foreign.terminate(child.pid, child.startId)).rejects.toThrow(/scope|identity/i)
        await expect(inspector.verify(child.pid, child.startId)).resolves.toBe('match')
        await expect(inspector.terminate(child.pid, child.startId)).resolves.toBe('dead')
      } finally {
        launcher.stdin.end()
        await closed
        lines.close()
      }
      const after = await inspector.snapshot()
      expect(after).toMatchObject({ launchComplete: true, processes: [{ role: 'compute' }] })
    } finally {
      await rm(scopeDir, { recursive: true, force: true })
    }
  },
  30_000
)
