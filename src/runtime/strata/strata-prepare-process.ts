import { posix, win32 } from 'node:path'
import { AtomicCoreError } from '../../contracts/index.js'
import { spawnManaged, type ManagedProcess, type SpawnSpec } from '../shared/index.js'
import type { StrataPreparationStep } from './strata-prepare-plan.js'

export interface StrataConverterContext {
  python: string
  controlDir: string
  stagingDir: string
  platform: NodeJS.Platform
  env: Readonly<Record<string, string | undefined>>
}

// These are trusted pinned converters, not arbitrary user Python. The audit hook makes their I/O
// contract explicit and testable. It is not a security sandbox for untrusted native extensions.
const bootstrap = String.raw`
import os,sys,runpy,threading
root,tool,stage=sys.argv[1:4]
args=sys.argv[4:]
stage=os.path.realpath(stage)
os.makedirs(os.path.join(stage,'.tmp'),exist_ok=True)
def owner_pipe():
    while os.read(0,1): pass
    os._exit(130)
if os.read(0,1)!=b'g': os._exit(130)
def writable(path):
    if not isinstance(path,(str,bytes,os.PathLike)): raise PermissionError('converter file descriptor mutation refused')
    dest=os.path.realpath(os.fsdecode(path))
    try: inside=os.path.commonpath([stage,dest])==stage
    except ValueError: inside=False
    if not inside: raise PermissionError('converter output must stay in derivative staging')
def audit(event,values):
    if event.startswith('socket.') or event in ('subprocess.Popen','os.system','os.fork','os.forkpty','os.exec','os.posix_spawn'):
        raise PermissionError('converter acquisition and child processes are disabled')
    if event=='open' and (values[2] & (os.O_WRONLY|os.O_RDWR|os.O_CREAT|os.O_TRUNC|os.O_APPEND)):
        writable(values[0])
    if event in ('os.remove','os.rmdir','os.mkdir','os.chmod','os.truncate','os.utime'):
        writable(values[0])
    if event in ('os.rename','os.link'):
        writable(values[0]); writable(values[1])
    if event=='os.symlink': raise PermissionError('converter symlinks are disabled')
sys.addaudithook(audit)
# On Windows NumPy's native module can hang if another thread has a pending stdin read.
# Load it under the audit hook before starting the watchdog; the converter reuses the import.
if sys.platform=='win32' and tool in ('tools/iq_pack.py','tools/dflash2_pack.py'):
    import numpy
threading.Thread(target=owner_pipe,daemon=True).start()
script=os.path.join(root,tool)
sys.path[:0]=[os.path.dirname(script),root,os.path.join(root,'third_party','llama.cpp','gguf-py')]
sys.argv=[script]+args
runpy.run_path(script,run_name='__main__')
`

/** The tokenizer runs first, so iq_pack never needs to create its own subprocess. */
export function strataConverterSpec(c: StrataConverterContext, step: StrataPreparationStep): SpawnSpec {
  const p = c.platform === 'win32' ? win32 : posix
  if (
    ![
      'tools/iq_pack.py',
      'tools/strata_tokenizer.py',
      'tools/dflash2_pack.py',
      'tools/dsv41/pack_gguf.py',
    ].includes(step.tool) ||
    [c.python, c.controlDir, c.stagingDir].some((v) => !p.isAbsolute(v) || v.includes('\0'))
  )
    throw new AtomicCoreError('INVALID_ARGUMENT', 'Invalid pinned Strata converter.')
  const windows = c.platform === 'win32'
  const systemRoot = c.env.SystemRoot ?? c.env.SYSTEMROOT ?? 'C:\\Windows'
  const systemDir = windows ? p.join(systemRoot, 'System32') : '/usr/bin:/bin'
  // Packaged Python may lack long-path support for ordinary Windows paths.
  const filePath = (value: string) => (windows ? win32.toNamespacedPath(value) : value)
  const stagingDir = filePath(c.stagingDir)
  const tempDir = p.join(stagingDir, '.tmp')
  const env: Record<string, string> = {
    PATH: systemDir,
    HOME: stagingDir,
    USERPROFILE: stagingDir,
    TEMP: tempDir,
    TMP: tempDir,
    TMPDIR: tempDir,
    PYTHONNOUSERSITE: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONUTF8: '1',
    STRATA_NO_ACQUIRE: '1',
    STRATA_NO_HANDOVER: '1',
  }
  if (windows) env.SystemRoot = systemRoot
  return {
    exe: c.python,
    args: [
      '-I',
      '-B',
      '-c',
      bootstrap,
      filePath(c.controlDir),
      step.tool,
      stagingDir,
      ...step.args.map((arg) => (p.isAbsolute(arg) ? filePath(arg) : arg)),
    ],
    env,
    // Windows cannot launch with a working directory past MAX_PATH. The bootstrap and recipes
    // already take absolute paths, including the writable staging directory.
    cwd: windows ? systemDir : c.stagingDir,
    stdin: 'pipe',
    platform: c.platform,
  }
}

/** Starts only after the caller persists its process identity; cancellation awaits confirmed exit. */
export async function runStrataPreparationStep(
  c: StrataConverterContext,
  step: StrataPreparationStep,
  signal: AbortSignal,
  onSpawn?: (process: ManagedProcess) => Promise<void>
): Promise<void> {
  const cancelled = () => new AtomicCoreError('MODEL_LOAD_CANCELLED', 'Strata preparation was cancelled.')
  if (signal.aborted) throw cancelled()
  const proc = spawnManaged(strataConverterSpec(c, step), undefined, { outputTailChars: 16 * 1024 })
  const stop = () => {
    proc.child.stdin?.end()
  }
  signal.addEventListener('abort', stop, { once: true })
  try {
    if (proc.pid <= 0) {
      await proc.exited
      if (signal.aborted) throw cancelled()
      throw new AtomicCoreError(
        'IO_ERROR',
        'Cannot start packaged Strata converter.',
        proc.spawnFailure()?.message
      )
    }
    await onSpawn?.(proc)
    if (signal.aborted) stop()
    else proc.child.stdin?.write('g')
    // EOF asks the Python watchdog to exit when the core disappears. Explicit cancellation also
    // kills a process stuck in a native extension and waits for its exit; recovery must still check
    // the journal before reusing staging after an owner crash.
    let cancel: (() => void) | undefined
    const aborted = new Promise<'cancel'>((resolve) => {
      cancel = () => resolve('cancel')
      signal.addEventListener('abort', cancel, { once: true })
      if (signal.aborted) cancel()
    })
    try {
      const outcome = await Promise.race([proc.exited, aborted])
      if (outcome === 'cancel') {
        await proc.terminate(0)
        throw cancelled()
      }
      if (signal.aborted) throw cancelled()
      if (proc.spawnFailure())
        throw new AtomicCoreError('IO_ERROR', 'Cannot start packaged Strata converter.')
      if (outcome.code !== 0)
        throw new AtomicCoreError(
          'MODEL_LOAD_FAILED',
          'Strata converter failed: ' + step.id,
          proc.output().stderr
        )
    } finally {
      if (cancel) signal.removeEventListener('abort', cancel)
    }
  } catch (error) {
    await proc.terminate(0)
    throw error
  } finally {
    signal.removeEventListener('abort', stop)
    proc.child.stdin?.end()
  }
}
