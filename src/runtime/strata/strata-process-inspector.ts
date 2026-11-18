import { execFile } from 'node:child_process'
import { AtomicCoreError } from '../../contracts/index.js'
import type { IdentityVerdict } from '../../lock/index.js'
import type { SpawnSpec } from '../shared/index.js'
import { strataControlPlan } from './strata-control-plan.js'
import type { StrataControlOptions } from './strata-control-plan.js'
import type { StrataProcessIdentity } from './strata-process-journal.js'

// Use the bundle's process tokens on all platforms. The helper never scans executable names,
// signals a process group, or reads another profile's ledger.
const inspect = String.raw`
import json, sys, re, stat
sys.path.insert(0, sys.argv[1])
from strata_control import procs, paths, private_files
from strata_control.atomic_owner import OWNER_CONTRACT
if OWNER_CONTRACT != 3:
    raise ValueError("Unsupported Atomic owner contract")
profile, mode, *args = sys.argv[2:]
if not re.fullmatch(r"atomic-[a-f0-9]{32}", profile):
    raise ValueError("Invalid profile")
directory = paths.state_base() / "atomic-processes" / profile
marker = directory / "ledger.json"
roles = {"owner": "owner", "server": "server", "engine": "compute", "vision": "vision", "guardian": "guardian"}
def read(path):
    st = path.lstat()
    if not stat.S_ISREG(st.st_mode) or st.st_size > 65536 or not private_files.is_private(path):
        raise ValueError("Invalid receipt")
    return json.loads(path.read_text(encoding="utf-8"))
def check_directory():
    if directory.resolve() != directory or not directory.is_dir() or not private_files.is_private(directory):
        raise ValueError("Invalid ledger directory")
def identity(row):
    if type(row["pid"]) is not int or row["pid"] <= 0 or not re.fullmatch(r"[lpws]:[^\x00\r\n]{1,200}", row["token"]):
        raise ValueError("Invalid process identity")
    return row["pid"], row["token"]
def rows():
    check_directory()
    if read(marker) != {"schema": 1, "profile": profile}:
        raise ValueError("Invalid ledger marker")
    receipts = []
    for path in sorted(directory.glob("*.json")):
        if path == marker:
            continue
        if not re.fullmatch(r"[a-f0-9]{32}\.json", path.name) or len(receipts) >= 256:
            raise ValueError("Invalid receipt name or count")
        row = read(path)
        if row["schema"] != 1 or row["profile"] != profile or row["role"] not in roles:
            raise ValueError("Invalid receipt scope or role")
        identity(row["parent"])
        if row["phase"] == "owned":
            identity(row)
            if not isinstance(row["cmd"], list) or not row["cmd"] or not all(isinstance(a, str) for a in row["cmd"]):
                raise ValueError("Invalid command identity")
        elif row["phase"] not in ("launching", "not-started", "exited"):
            raise ValueError("Invalid receipt phase")
        receipts.append(row)
    return receipts
def verdict(pid, expected):
    ps = procs.psutil
    try:
        p = ps.Process(pid)
        if p.status() == ps.STATUS_ZOMBIE:
            return "dead"
        actual = procs.start_token(pid)
        if not actual:
            return "unknown"
        return "match" if actual == expected else "mismatch"
    except ps.NoSuchProcess:
        return "dead"
    except (ps.Error, OSError):
        return "unknown"
result = {"profile": profile}
if mode == "initialize":
    private_files.private_mkdir(directory, parents=True, exist_ok=True)
    check_directory()
    with marker.open("x", encoding="utf-8") as f:
        private_files.restrict_to_current_user(marker, directory=False)
        json.dump({"schema": 1, "profile": profile}, f)
        f.flush()
        import os
        os.fsync(f.fileno())
    result["initialized"] = True
elif mode == "snapshot":
    observed = rows()
    processes = []
    settled = True
    for row in observed:
        parent_pid, parent_token = identity(row["parent"])
        if verdict(parent_pid, parent_token) not in ("dead", "mismatch"):
            settled = False
        if row["phase"] == "launching":
            settled = False
        if row["phase"] != "owned":
            continue
        pid, start = identity(row)
        processes.append({"pid": pid, "startId": "strata:" + start, "role": roles[row["role"]]})
        if row["role"] in ("owner", "server") and verdict(pid, start) not in ("dead", "mismatch"):
            settled = False
    result.update(processes=processes, launchComplete=settled and rows() == observed)
elif mode == "identify":
    start = procs.start_token(int(args[0]))
    result["startId"] = "strata:" + start if start else None
elif mode in ("verify", "terminate"):
    pid, start = int(args[0]), args[1].removeprefix("strata:")
    result["verdict"] = verdict(pid, start)
    if mode == "terminate" and result["verdict"] == "match":
        record = next((row for row in rows() if row["phase"] == "owned" and identity(row) == (pid, start)), None)
        if not record:
            raise ValueError("Process is not recorded in this profile")
        process = procs.psutil.Process(pid)
        if procs.command_line(pid) != record["cmd"] or verdict(pid, start) != "match":
            result["verdict"] = "unknown"
        else:
            try:
                process.kill()
                process.wait(timeout=10)
            except procs.psutil.NoSuchProcess:
                pass
            except (procs.psutil.Error, OSError):
                pass
            result["verdict"] = verdict(pid, start)
else:
    raise ValueError("Unsupported inspection")
print(json.dumps(result))
`

type Run = (spec: SpawnSpec) => Promise<string>
const runInspector: Run = (spec) =>
  new Promise((resolve, reject) => {
    execFile(
      spec.exe,
      spec.args,
      { cwd: spec.cwd, env: spec.env, windowsHide: true, timeout: 20_000, maxBuffer: 512 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(stdout))
    )
  })
const roles = new Set(['owner', 'server', 'compute', 'vision', 'guardian'])
const validPid = (pid: unknown): pid is number => Number.isSafeInteger(pid) && Number(pid) > 0
const validStartId = (id: unknown): id is string =>
  typeof id === 'string' && !id.includes('\0') && /^strata:[lpws]:[^\r\n]{1,200}$/.test(id)

function invalid(): never {
  throw new AtomicCoreError(
    'GPU_BUSY',
    'Strata process evidence is missing or has an invalid scope or identity.'
  )
}

/** Reads the retained Control receipts in one private scope. */
export class StrataProcessInspector {
  constructor(
    private readonly options: StrataControlOptions,
    private readonly run: Run = runInspector
  ) {}

  async initialize(): Promise<void> {
    if ((await this.command('initialize')).initialized !== true) invalid()
  }

  async snapshot(): Promise<{ processes: StrataProcessIdentity[]; launchComplete: boolean }> {
    const { processes, launchComplete } = await this.command('snapshot')
    if (!Array.isArray(processes) || typeof launchComplete !== 'boolean') invalid()
    const seen = new Set<number>()
    for (const p of processes) {
      if (!p || !validPid(p.pid) || !validStartId(p.startId) || !roles.has(p.role) || seen.has(p.pid))
        invalid()
      seen.add(p.pid)
    }
    return { processes, launchComplete }
  }

  async identify(pid: number): Promise<string> {
    if (!validPid(pid)) invalid()
    const { startId } = await this.command('identify', String(pid))
    return validStartId(startId) ? startId : invalid()
  }

  async verify(pid: number, startId: string | null): Promise<IdentityVerdict> {
    if (!validPid(pid) || !validStartId(startId)) return 'unknown'
    return this.compare('verify', pid, startId).catch(() => 'unknown')
  }

  async terminate(pid: number, startId: string | null): Promise<IdentityVerdict> {
    if (!validPid(pid) || !validStartId(startId)) invalid()
    return this.compare('terminate', pid, startId)
  }

  private async compare(
    mode: 'verify' | 'terminate',
    pid: number,
    startId: string
  ): Promise<IdentityVerdict> {
    const { verdict } = await this.command(mode, String(pid), startId)
    if (verdict === 'match' || verdict === 'dead' || verdict === 'mismatch' || verdict === 'unknown')
      return verdict
    return invalid()
  }

  private async command(mode: string, ...args: string[]): Promise<Record<string, unknown>> {
    const spec = strataControlPlan(this.options, { kind: 'status' })
    try {
      const stdout = await this.run({
        ...spec,
        args: ['-I', '-B', '-c', inspect, spec.cwd!, this.options.profile, mode, ...args],
      })
      const raw = JSON.parse(stdout) as Record<string, unknown> | null
      if (!raw || raw.profile !== this.options.profile) invalid()
      return raw
    } catch {
      return invalid()
    }
  }
}
