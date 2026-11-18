import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { expect, it } from 'vitest'
const run = promisify(execFile)
const bundle = process.env['ATOMIC_TEST_STRATA_TREE']
it.skipIf(!bundle || process.platform !== 'darwin')(
  'ends compute if its Atomic owner-death watcher cannot be recorded',
  async () => {
    const script = `
import os,sys,json,subprocess
sys.path.insert(0,sys.argv[1])
from serve import lifeline
os.environ['STRATA_ATOMIC_OWNER']='1'
child=subprocess.Popen([sys.executable,'-I','-B','-c','import time; time.sleep(60)'])
def unavailable(*a,**kw): raise OSError('injected ledger failure')
lifeline.atomic_popen=unavailable
refused=False
try:
 try: lifeline._watch(child)
 except OSError: refused=True
 try: child.wait(timeout=1)
 except subprocess.TimeoutExpired: pass
 print(json.dumps({'refused':refused,'exited':child.poll() is not None}))
finally:
 if child.poll() is None: child.kill()
 child.wait(timeout=5)
`
    const result = await run(
      join(bundle!, 'control/python/bin/python3'),
      ['-I', '-B', '-c', script, join(bundle!, 'control')],
      { timeout: 15000 }
    )
    expect(JSON.parse(result.stdout)).toEqual({ refused: true, exited: true })
  }
)
it.skipIf(!bundle)('refuses automatic compute restart when Atomic owns residency', async () => {
  const script = `
import os,sys,json,contextlib,io
sys.path.insert(0,sys.argv[1])
from serve.server import Service,EngineDied
from types import SimpleNamespace
calls=[]
engine=SimpleNamespace(alive=lambda:False,exit_code=lambda:1,restart=lambda:calls.append('restart'))
s=object.__new__(Service)
s.engine=engine; s.vision=None; s.before_load=None; s.min_free_vram_mib=0; s.restore_after_load=False; s.vram_reserve=None
os.environ['STRATA_ATOMIC_OWNER']='1'
refused=False
with contextlib.redirect_stdout(io.StringIO()):
 try: s.ensure_loaded()
 except EngineDied: refused=True
owned=list(calls)
os.environ.pop('STRATA_ATOMIC_OWNER')
with contextlib.redirect_stdout(io.StringIO()): s.ensure_loaded()
print(json.dumps({'refused':refused,'owned_restarts':len(owned),'standalone_restarts':len(calls)-len(owned)}))
`
  const result = await run(
    join(bundle!, process.platform === 'win32' ? 'control/python/python.exe' : 'control/python/bin/python3'),
    ['-I', '-B', '-c', script, join(bundle!, 'control')],
    { timeout: 15000, maxBuffer: 64 * 1024 }
  )
  expect(JSON.parse(result.stdout)).toEqual({ refused: true, owned_restarts: 0, standalone_restarts: 1 })
})
