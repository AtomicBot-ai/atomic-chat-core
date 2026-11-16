import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const bundle = process.env.ATOMIC_TEST_STRATA_TREE
const run = promisify(execFile)
// Runs the pinned package's actual parent-loss guard, with a tiny server/compute stand-in.
// No model, network listener or system Python. Finally always reaps the isolated fixture group.
it.skipIf(!bundle || process.platform === 'win32')(
  'Strata owner loss terminates compute descendants even when the HTTP server exits first',
  async () => {
    const script = String.raw`
import json, os, pathlib, signal, subprocess, sys, time
import psutil
root = pathlib.Path(sys.argv[1])
read_fd, write_fd = os.pipe()
server_code = '''
import os, signal, subprocess, sys, time
sys.path.insert(0, sys.argv[1])
from serve.owner_guard import start
from serve import lifeline
compute = lifeline.popen([sys.executable, '-I', '-B', '-c', 'import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); print("ready", flush=True); time.sleep(30)'], stdout=subprocess.PIPE, text=True)
assert compute.stdout.readline().strip() == 'ready'
print(compute.pid, flush=True)
start(int(sys.argv[2]), grace=0.2)
time.sleep(30)
'''
server = subprocess.Popen([sys.executable, '-I', '-B', '-c', server_code, str(root / 'control'), str(read_fd)], pass_fds=(read_fd,), stdout=subprocess.PIPE, text=True, start_new_session=True)
os.close(read_fd)
compute_pid = None
compute = None
try:
    compute_pid = int(server.stdout.readline())
    compute = psutil.Process(compute_pid)
    os.close(write_fd)  # exactly the EOF produced by a killed owner
    server.wait(timeout=5)
    deadline = time.monotonic() + 15
    alive = True
    while alive and time.monotonic() < deadline:
        try:
            alive = compute.is_running() and compute.status() != psutil.STATUS_ZOMBIE
        except psutil.NoSuchProcess:
            alive = False
        if alive: time.sleep(0.1)
    print(json.dumps({'server_exited': True, 'compute_alive': alive}))
finally:
    try:
        if server.poll() is None: os.killpg(server.pid, signal.SIGKILL)
    except ProcessLookupError: pass
    if compute is not None:
        try: compute.kill()
        except psutil.NoSuchProcess: pass
    server.wait(timeout=5)
`
    const state = await mkdtemp(join(tmpdir(), 'atomic-strata-owner-'))
    try {
      const result = await run(
        join(bundle!, 'control/python/bin/python3'),
        ['-I', '-B', '-c', script, bundle!],
        {
          env: {
            STRATA_ATOMIC_OWNER: '1',
            STRATA_RUNTIME_PROFILE: 'atomic-' + 'a'.repeat(32),
            PATH: '/usr/bin:/bin',
            HOME: state,
            XDG_STATE_HOME: state,
            STRATA_NO_ACQUIRE: '1',
          },
          timeout: 25000,
        }
      )
      expect(JSON.parse(result.stdout)).toEqual({ server_exited: true, compute_alive: false })
    } finally {
      await rm(state, { recursive: true, force: true })
    }
  }
)
