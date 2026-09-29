/**
 * The real Linux machine the managed TensorRT-LLM live tests run on (install, task 2.18; engine, task
 * 2.19): what the machine is before the core touches it, read by the test itself — independently of
 * the core's own probe, so the two can be compared — and which of the brief's scenarios that starting
 * state can exercise.
 *
 * Everything here is read-only except `sudo`, which the test uses for what its own unprivileged
 * session cannot see (the Docker daemon before the relogin, container logs, `daemon.json`) and for
 * the privileged host step itself. The VM user needs passwordless sudo (`docs/live-tests.md`).
 *
 * No imports from `src/`: the live test drives the compiled binary only. The version and os-release
 * parsing are deliberately re-implemented, so a bug in the core's probe cannot hide in the check.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { totalmem, userInfo } from 'node:os'

export interface CommandResult {
  /** Null when the command could not start (not installed) or timed out. */
  code: number | null
  stdout: string
  stderr: string
}

/** Runs one argv without a shell; never throws. */
export function run(command: string, args: string[], timeoutMs = 120_000): CommandResult {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: timeoutMs })
  return {
    code: result.error ? null : result.status,
    stdout: result.stdout ?? '',
    stderr: result.error ? String(result.error.message) : (result.stderr ?? ''),
  }
}

/**
 * The same, without blocking the event loop — for the privileged step, which can run for many
 * minutes while the core's event stream must keep being read.
 */
export function runAsync(command: string, args: string[], timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs)
    child.once('error', (error) => {
      clearTimeout(timer)
      resolve({ code: null, stdout, stderr: `${stderr}${error.message}` })
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

/** `sudo -n …`: fails at once instead of prompting when passwordless sudo is missing. */
export const sudo = (args: string[], timeoutMs?: number): CommandResult =>
  run('sudo', ['-n', ...args], timeoutMs)

/** The system docker CLI, the same fixed locations the core resolves (never `PATH`). */
export const DOCKER_CANDIDATES = ['/usr/bin/docker', '/usr/local/bin/docker', '/bin/docker'] as const
export const dockerCli = (): string | null => DOCKER_CANDIDATES.find((path) => existsSync(path)) ?? null
const SOCKET = 'unix:///var/run/docker.sock'

/** `docker -H unix:///var/run/docker.sock …` as root; the daemon the core talks to. */
export function sudoDocker(args: string[], timeoutMs?: number): CommandResult {
  const cli = dockerCli()
  if (cli === null) return { code: null, stdout: '', stderr: 'no docker CLI' }
  return sudo([cli, '-H', SOCKET, ...args], timeoutMs)
}

/** `sudoDocker` without blocking the event loop: for sampling while a load request is in flight. */
export function sudoDockerAsync(args: string[], timeoutMs: number): Promise<CommandResult> {
  const cli = dockerCli()
  if (cli === null) return Promise.resolve({ code: null, stdout: '', stderr: 'no docker CLI' })
  return runAsync('sudo', ['-n', cli, '-H', SOCKET, ...args], timeoutMs)
}

export interface OsRelease {
  id: string
  id_like: string[]
  version_id: string | null
  variant_id: string | null
  pretty_name: string
}

export function parseOsRelease(text: string): OsRelease {
  const values = new Map<string, string>()
  for (const line of text.split('\n')) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim())
    if (match === null) continue
    let value = match[2] ?? ''
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1)
    values.set(match[1] as string, value)
  }
  return {
    id: (values.get('ID') ?? '').toLowerCase(),
    id_like: (values.get('ID_LIKE') ?? '').toLowerCase().split(/\s+/).filter(Boolean),
    version_id: values.get('VERSION_ID') ?? null,
    variant_id: values.get('VARIANT_ID') ?? null,
    pretty_name: values.get('PRETTY_NAME') ?? values.get('NAME') ?? 'unknown',
  }
}

/** Numeric, segment by segment: `590.44.01` ≥ `590.44.1`, `590.100` > `590.44`. */
export function compareVersions(a: string, b: string): number {
  const left = a.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0)
  const right = b.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0)
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff !== 0) return diff < 0 ? -1 : 1
  }
  return 0
}

export interface LiveGpu {
  uuid: string
  name: string
  compute_capability: string
  /** Null for a unified-memory card (GB10) that reports `[N/A]`: it uses host memory (design D13). */
  total_bytes: number | null
  free_bytes: number | null
  driver_version: string
}

const MIB = 1024 * 1024
const mib = (cell: string | undefined): number | null =>
  cell !== undefined && /^\d+(\.\d+)?$/.test(cell) ? Math.round(Number(cell) * MIB) : null

/** What a card offers a model: its own VRAM, or host memory for a unified-memory card (D13). */
export const cardBytes = (gpu: Pick<LiveGpu, 'total_bytes'>): number => gpu.total_bytes ?? totalmem()

/** `nvidia-smi --query-gpu=uuid,name,compute_cap,memory.total,memory.free,driver_version --format=csv,noheader,nounits`. */
export function parseNvidiaSmi(csv: string): LiveGpu[] {
  return csv
    .split('\n')
    .map((line) => line.split(',').map((cell) => cell.trim()))
    .filter((cells) => cells.length >= 6 && cells[0]?.startsWith('GPU-'))
    .map(([uuid, name, cc, total, free, driver]) => ({
      uuid: uuid as string,
      name: name as string,
      compute_capability: cc as string,
      total_bytes: mib(total),
      free_bytes: mib(free),
      driver_version: driver as string,
    }))
}

/**
 * `nvidia-smi --query-gpu=uuid,memory.used --format=csv,noheader,nounits`: each card's used memory in
 * bytes, by UUID; null for a unified-memory card that reports `[N/A]`.
 */
export function parseMemoryUsed(csv: string): Map<string, number | null> {
  const used = new Map<string, number | null>()
  for (const line of csv.split('\n')) {
    const [uuid, cell] = line.split(',').map((part) => part.trim())
    if (uuid?.startsWith('GPU-')) used.set(uuid, mib(cell))
  }
  return used
}

/** Every card's used memory now (see `parseMemoryUsed`); empty when nvidia-smi does not answer. */
export async function gpuMemoryUsed(): Promise<Map<string, number | null>> {
  const out = await runAsync(
    'nvidia-smi',
    ['--query-gpu=uuid,memory.used', '--format=csv,noheader,nounits'],
    30_000
  )
  return out.code === 0 ? parseMemoryUsed(out.stdout) : new Map()
}

export type PackageFamily = 'apt' | 'dnf' | 'pacman' | 'other'

export function packageFamily(os: OsRelease): PackageFamily {
  const ids = [os.id, ...os.id_like]
  if (ids.some((id) => id === 'arch')) return 'pacman'
  if (ids.some((id) => id === 'debian' || id === 'ubuntu')) return 'apt'
  if (ids.some((id) => id === 'fedora' || id === 'rhel')) return 'dnf'
  return 'other'
}

/** How Docker Engine got onto this machine, by package; null when there is no Docker package. */
export type DockerPackage = 'docker-ce' | 'docker.io' | 'moby-engine' | 'docker' | null

export interface DockerFacts {
  cli: string | null
  package: DockerPackage
  service_active: boolean
  /** `systemctl show -p MainPID docker`: changes exactly when Docker restarts. */
  main_pid: string | null
  /** `docker info` as this very process — the check the relogin is about. */
  user_reaches_daemon: boolean
  /** As root; null while there is no daemon to ask. */
  running_containers: number | null
  /** A runtime named `nvidia` loaded by the daemon. */
  nvidia_runtime_loaded: boolean
  /** `nvidia-ctk cdi list` names an NVIDIA device and the daemon has CDI spec dirs. */
  nvidia_cdi: boolean
  security_options: string[]
}

export interface HostFacts {
  os: OsRelease
  arch: string
  kernel: string
  family: PackageFamily
  /** `(id, version_id, arch)` is on the descriptor's `linux.install-container-runtime` list. */
  in_recipe: boolean
  /** rpm-ostree (Silverblue, Kinoite, Bazzite): no recipe path, a blocker. */
  immutable: boolean
  user: string
  uid: number
  /** This process's supplementary groups, by name: what the running session carries. */
  groups_effective: string[]
  /** `getent group docker` members: what a fresh login would carry. */
  docker_group_members: string[]
  docker_gid: number | null
  passwordless_sudo: boolean
  /**
   * `sudo -n -u <self> true`: the relogin emulation starts a core as this same user through sudo, which
   * a rule like `(root) NOPASSWD: ALL` passes for root yet refuses for the user.
   */
  passwordless_sudo_as_self: boolean
  gpus: LiveGpu[]
  driver_version: string | null
  selinux: 'enforcing' | 'permissive' | 'disabled' | null
  toolkit_installed: boolean
  docker: DockerFacts
}

export interface RecipeDescriptor {
  descriptor_id: string
  minimum_driver_version: string
  minimum_compute_capability: string
  recipes: Array<{
    recipe_id: string
    distributions: Array<{ id: string; version_id: string; arch: string }>
  }>
}

function installedPackage(family: PackageFamily, name: string): boolean {
  if (family === 'apt') {
    const out = run('dpkg-query', ['--show', '--showformat=${Status}', name])
    return out.code === 0 && out.stdout.trim().endsWith(' installed')
  }
  if (family === 'dnf') return run('rpm', ['--query', name]).code === 0
  if (family === 'pacman') return run('pacman', ['-Q', name]).code === 0
  return false
}

function dockerPackage(family: PackageFamily): DockerPackage {
  const candidates: DockerPackage[] =
    family === 'apt'
      ? ['docker-ce', 'docker.io']
      : family === 'dnf'
        ? ['docker-ce', 'moby-engine']
        : family === 'pacman'
          ? ['docker']
          : []
  return candidates.find((name) => name !== null && installedPackage(family, name)) ?? null
}

interface DockerInfo {
  ServerVersion?: string
  ContainersRunning?: number
  Runtimes?: Record<string, unknown>
  SecurityOptions?: string[]
  CDISpecDirs?: string[]
}

/**
 * `docker info --format '{{json .}}'` that a daemon actually answered. An older CLI exits 0 with a
 * "permission denied" line and a JSON body without `ServerVersion`, so the exit code alone lies.
 */
function dockerInfo(out: CommandResult): DockerInfo | null {
  if (out.code !== 0) return null
  try {
    const info = JSON.parse(out.stdout.trim().split('\n').pop() ?? '') as DockerInfo
    return typeof info.ServerVersion === 'string' && info.ServerVersion !== '' ? info : null
  } catch {
    return null
  }
}

function dockerFacts(): DockerFacts {
  const cli = dockerCli()
  const active = run('systemctl', ['is-active', 'docker']).stdout.trim() === 'active'
  const pid = run('systemctl', ['show', '-p', 'MainPID', '--value', 'docker'])
  const mainPid =
    pid.code === 0 && pid.stdout.trim() !== '' && pid.stdout.trim() !== '0' ? pid.stdout.trim() : null
  const asUser = cli === null ? null : run(cli, ['-H', SOCKET, 'info', '--format', '{{json .}}'])
  const asRoot = cli === null || !active ? null : sudoDocker(['info', '--format', '{{json .}}'])
  const info = asRoot === null ? null : dockerInfo(asRoot)
  const cdiList = run('nvidia-ctk', ['cdi', 'list'])
  return {
    cli,
    package: null,
    service_active: active,
    main_pid: mainPid,
    user_reaches_daemon: asUser !== null && dockerInfo(asUser) !== null,
    running_containers: typeof info?.ContainersRunning === 'number' ? info.ContainersRunning : null,
    nvidia_runtime_loaded: info?.Runtimes !== undefined && 'nvidia' in info.Runtimes,
    nvidia_cdi:
      cdiList.code === 0 && /nvidia\.com\/gpu/.test(cdiList.stdout) && (info?.CDISpecDirs?.length ?? 0) > 0,
    security_options: info?.SecurityOptions ?? [],
  }
}

/** Reads the machine. `descriptor` decides whether this distribution is on the recipe's list. */
export function detectHost(descriptor: RecipeDescriptor): HostFacts {
  const os = parseOsRelease(existsSync('/etc/os-release') ? readFileSync('/etc/os-release', 'utf8') : '')
  const arch = run('uname', ['-m']).stdout.trim()
  const family = packageFamily(os)
  const recipe = descriptor.recipes.find((r) => r.recipe_id === 'linux.install-container-runtime')
  const inRecipe =
    recipe?.distributions.some((d) => d.id === os.id && d.version_id === os.version_id && d.arch === arch) ??
    false
  const smi = run('nvidia-smi', [
    '--query-gpu=uuid,name,compute_cap,memory.total,memory.free,driver_version',
    '--format=csv,noheader,nounits',
  ])
  const gpus = smi.code === 0 ? parseNvidiaSmi(smi.stdout) : []
  const enforce = run('getenforce', [])
  const selinux = enforce.code === 0 ? (enforce.stdout.trim().toLowerCase() as HostFacts['selinux']) : null
  const group = run('getent', ['group', 'docker'])
  const groupFields = group.code === 0 ? group.stdout.trim().split(':') : []
  const docker = dockerFacts()
  docker.package = dockerPackage(family)
  const me = userInfo()
  return {
    os,
    arch,
    kernel: run('uname', ['-r']).stdout.trim(),
    family,
    in_recipe: inRecipe,
    immutable: existsSync('/run/ostree-booted'),
    user: me.username,
    uid: me.uid,
    groups_effective: run('id', ['-nG']).stdout.trim().split(/\s+/).filter(Boolean),
    docker_group_members: (groupFields[3] ?? '').split(',').filter(Boolean),
    docker_gid: groupFields[2] === undefined ? null : Number(groupFields[2]),
    passwordless_sudo: run('sudo', ['-n', 'true']).code === 0,
    passwordless_sudo_as_self: run('sudo', ['-n', '-u', me.username, 'true']).code === 0,
    gpus,
    driver_version: gpus[0]?.driver_version ?? null,
    selinux,
    toolkit_installed: installedPackage(family, 'nvidia-container-toolkit'),
    docker,
  }
}

/**
 * Which way the setup must go on this machine, as the brief's scenarios see it:
 * - `adopt` — Docker answers this session and has a GPU runtime: no privileged step at all;
 * - `install` — a recipe distribution with no Docker: the full plan, the group and a relogin;
 * - `complete` — a recipe distribution with Docker but a missing toolkit, runtime or access;
 * - `arch-blocked` — Arch (or `ID_LIKE=arch`) with something missing: manual commands only;
 * - `unsupported` — anything else; nothing to exercise.
 */
export type SetupPath = 'adopt' | 'install' | 'complete' | 'arch-blocked' | 'unsupported'

export function setupPath(facts: HostFacts): SetupPath {
  const gpuRuntime = facts.docker.nvidia_runtime_loaded || facts.docker.nvidia_cdi
  if (facts.docker.user_reaches_daemon && gpuRuntime) return 'adopt'
  if (facts.family === 'pacman') return 'arch-blocked'
  if (!facts.in_recipe || facts.immutable) return 'unsupported'
  return facts.docker.cli === null ? 'install' : 'complete'
}

/** Why the VM cannot run this test at all; empty when it can. */
export function preconditionProblems(facts: HostFacts, descriptor: RecipeDescriptor): string[] {
  const problems: string[] = []
  if (facts.uid === 0)
    problems.push('run the test as a normal user with passwordless sudo, not as root (root needs no relogin)')
  if (!facts.passwordless_sudo) problems.push('passwordless sudo is required (`sudo -n true` failed)')
  else if (!facts.passwordless_sudo_as_self)
    problems.push(
      `passwordless sudo to ${facts.user} itself is required for the relogin emulation ` +
        `(\`sudo -n -u ${facts.user} true\` failed; use \`${facts.user} ALL=(ALL) NOPASSWD: ALL\`)`
    )
  if (facts.arch !== 'x86_64' && facts.arch !== 'aarch64')
    problems.push(`unsupported architecture ${facts.arch}`)
  if (facts.gpus.length === 0)
    problems.push('no NVIDIA GPU is visible to nvidia-smi (driver or passthrough missing)')
  if (
    facts.driver_version !== null &&
    compareVersions(facts.driver_version, descriptor.minimum_driver_version) < 0
  )
    problems.push(
      `NVIDIA driver ${facts.driver_version} is older than the descriptor's minimum ${descriptor.minimum_driver_version}`
    )
  if (
    facts.gpus.length > 0 &&
    facts.gpus.every(
      (gpu) => compareVersions(gpu.compute_capability, descriptor.minimum_compute_capability) < 0
    )
  )
    problems.push(
      `every GPU is below compute capability ${descriptor.minimum_compute_capability} (Ampere or newer is needed)`
    )
  return problems
}

/**
 * The installed-package set, hashed: equal before and after a no-op recipe run means nothing was
 * installed, upgraded or removed.
 */
export function packageSetDigest(family: PackageFamily): string | null {
  const out =
    family === 'apt'
      ? run('dpkg-query', ['--show', '--showformat=${Package} ${Version} ${Status}\n'])
      : family === 'dnf'
        ? run('rpm', ['--query', '--all', '--queryformat', '%{NAME}-%{EVR}.%{ARCH}\n'])
        : null
  if (out === null || out.code !== 0) return null
  const lines = out.stdout.split('\n').filter(Boolean).sort()
  return `sha256:${createHash('sha256').update(lines.join('\n')).digest('hex')}`
}

/** `/etc/docker/daemon.json` as root, hashed; null when absent. */
export function daemonJsonDigest(): string | null {
  const out = sudo(['cat', '/etc/docker/daemon.json'])
  return out.code === 0 ? `sha256:${createHash('sha256').update(out.stdout).digest('hex')}` : null
}

/** A group's gid as `getent group` reports it now; null when there is no such group. */
export function groupGid(name: string): number | null {
  const out = run('getent', ['group', name])
  const gid = out.code === 0 ? out.stdout.trim().split(':')[2] : undefined
  return gid === undefined || !/^\d+$/.test(gid) ? null : Number(gid)
}

/**
 * Every gid a process holds, from the text of `/proc/<pid>/status`: the real and effective gids
 * (`Gid:`) and the supplementary ones (`Groups:`, which never lists the primary gid). Null when the
 * text has neither line, so an unreadable or foreign file is "unknown" and not "holds no group".
 */
export function parseProcessGroups(status: string): number[] | null {
  const gids = /^Gid:[ \t]*(.*)$/m.exec(status)?.[1]
  const groups = /^Groups:[ \t]*(.*)$/m.exec(status)?.[1]
  if (gids === undefined && groups === undefined) return null
  const numbers = (line: string | undefined): number[] =>
    (line ?? '')
      .split(/\s+/)
      .filter((part) => /^\d+$/.test(part))
      .map(Number)
  // The real and effective gids only: the saved and filesystem ones are not what a client's session carries.
  return [...new Set([...numbers(gids).slice(0, 2), ...numbers(groups)])]
}

/** The gids a running process holds (see `parseProcessGroups`); null when `/proc/<pid>/status` cannot be read. */
export function processGroups(pid: number): number[] | null {
  try {
    return parseProcessGroups(readFileSync(`/proc/${pid}/status`, 'utf8'))
  } catch {
    return null
  }
}
