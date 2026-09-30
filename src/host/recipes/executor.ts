/**
 * The privileged half of a host step (design D3): read one request file, refuse it unless it names
 * this build's recipe with matching digests and valid parameters, bring the machine to what the
 * recipe describes, and write the result file beside the request. `atomic-chat-core host-step exec`
 * and `atc host-step exec` both call `executeHostStep`, so the app and the CLI run the same code
 * as root.
 *
 * Every step checks the machine before it acts and does nothing when its part is already in place.
 * That makes the whole request idempotent: a replay — a retried receipt, a person re-running the
 * manual command — reports `completed` without changing anything. The first failing step stops the
 * run; the ones after it are reported `not-run`, never attempted.
 *
 * All I/O is injected (`HostStepExecutorDeps`); `executor-io.ts` has the real implementations.
 * This file never touches the file system, the network or a process itself.
 */

import { basename } from 'node:path'
import { AtomicCoreError } from '../../contracts/index.js'
import {
  INSTALL_CONTAINER_RUNTIME_RECIPE,
  INSTALL_CONTAINER_RUNTIME_RECIPE_DIGEST,
  INSTALL_CONTAINER_RUNTIME_RECIPE_ID,
  assertPermittedCommand,
  buildInstallContainerRuntimeSteps,
  installContainerRuntimeParametersDigest,
  isPackageName,
  validateInstallContainerRuntimeParameters,
} from './install-container-runtime.js'
import type { HostRecipeStep } from './install-container-runtime.js'
import { dearmorPublicKey, primaryKeyFingerprints } from './openpgp.js'
import { parseHostStepRequest, resultPathFor } from './request-file.js'
import type { HostStepEcho, HostStepResult, HostStepStepOutcome } from './request-file.js'

export interface HostCommandOutput {
  /** Null when the command could not run or answer at all. */
  code: number | null
  stdout: string
  stderr: string
}

export interface HostStepExecutorDeps {
  /** The request's text. Throws when it is not a readable regular file of sane size. */
  readRequest: (path: string) => Promise<string>
  /** Writes the result without following a link planted at its path. */
  writeResult: (path: string, text: string) => Promise<void>
  /** A file's bytes, or null when there is no file there. */
  readFile: (path: string) => Promise<Uint8Array | null>
  /** Atomically creates or replaces a file with exactly this mode, creating parent directories. */
  writeFile: (path: string, data: Uint8Array, mode: number) => Promise<void>
  /**
   * Runs one argv, no shell, with the recipe's fixed environment. `longRunning` marks a package
   * install: a much longer deadline, and SIGTERM before SIGKILL, so dpkg is not killed mid-run.
   * `diagnostic` marks a read made only to explain a failure: a short deadline and a small output
   * cap, so explaining never holds the result back.
   */
  exec: (
    argv: string[],
    options?: { longRunning?: boolean; diagnostic?: boolean }
  ) => Promise<HostCommandOutput>
  fetch: typeof fetch
  now: () => number
  /**
   * The uid of the person who asked for elevation (`PKEXEC_UID`, `SUDO_UID`), or null when this
   * process was started as root directly. When known, only that account is added to `docker`.
   */
  invokingUid: string | null
}

const STDERR_LIMIT = 2000
const KEY_SIZE_LIMIT = 256 * 1024
const KEY_FETCH_TIMEOUT_MS = 60_000

const tail = (text: string): string => text.trim().slice(-STDERR_LIMIT)
/** The start of a message, bounded: a refusal can name keys an attacker chose. */
const head = (text: string): string =>
  text.length <= STDERR_LIMIT ? text : `${text.slice(0, STDERR_LIMIT - 3)}...`

/**
 * Why a step could not do its part; carries the command's exit code and stderr when there was one.
 * Internal: it is always caught and turned into a `failed` step outcome, never thrown to a caller.
 */
class StepFailure extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null = null,
    readonly stderr = ''
  ) {
    super(message)
  }
}

type StepDone = { status: 'satisfied' | 'applied'; detail: string }

interface RunContext {
  deps: HostStepExecutorDeps
  /** Docker's state before this run touched anything; decides whether a restart needs consent. */
  dockerActiveAtStart: boolean
}

async function run(
  context: RunContext,
  argv: string[],
  options?: { longRunning?: boolean; diagnostic?: boolean }
): Promise<HostCommandOutput> {
  assertPermittedCommand(argv)
  return context.deps.exec(argv, options)
}

async function mustRun(
  context: RunContext,
  argv: string[],
  options?: { longRunning?: boolean }
): Promise<void> {
  const output = await run(context, argv, options)
  if (output.code !== 0)
    throw new StepFailure(`${argv.join(' ')} exited with ${String(output.code)}`, output.code, output.stderr)
}

/**
 * Starts or restarts Docker; when that fails, the failure's stderr also carries the tail of
 * docker.service's journal, because `systemctl` only says "see journalctl" and the reason (say,
 * "all predefined address pools have been fully subnetted" under a full-tunnel VPN) is there. The
 * journal read can only add text: when it cannot run, fails or prints nothing, the failure is
 * exactly what it would have been without it. The outcome's `tail` keeps the end of the combined
 * text, so the reason survives the stderr limit.
 */
async function mustStartDocker(context: RunContext, argv: string[], journal: string[]): Promise<void> {
  const output = await run(context, argv)
  if (output.code === 0) return
  let reason = ''
  try {
    const read = await run(context, journal, { diagnostic: true })
    if (read.code === 0) reason = read.stdout.trim()
  } catch {
    // No journal to read (not permitted, not installed, could not spawn): systemctl's own words stand.
  }
  const said = output.stderr.trim()
  const stderr = reason === '' ? said : `${said}\n${journal.slice(0, 3).join(' ')}:\n${reason}`
  throw new StepFailure(`${argv.join(' ')} exited with ${String(output.code)}`, output.code, stderr)
}

/**
 * `systemctl reset-failed docker.service docker.socket`, right before a start or restart (task 2.23,
 * F-6): a start that failed before — the full-tunnel VPN of F-4 — leaves both units `failed` with
 * `start-limit-hit`, and systemd refuses to start them again for a while, so the retry would fail on
 * that leftover rather than on its cause. The exit status says nothing useful (a unit that is not
 * failed is simply left alone) and is ignored.
 */
async function resetFailed(context: RunContext, argv: string[]): Promise<void> {
  await run(context, argv)
}

const bytesEqual = (a: Uint8Array | null, b: Uint8Array | null): boolean =>
  a === null || b === null ? a === b : Buffer.from(a).equals(Buffer.from(b))

async function installKey(
  context: RunContext,
  step: Extract<HostRecipeStep, { kind: 'install-key' }>
): Promise<StepDone> {
  if ((await context.deps.readFile(step.path)) !== null)
    return { status: 'satisfied', detail: `kept the existing ${step.path}` }
  let response: Response
  try {
    response = await context.deps.fetch(step.url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(KEY_FETCH_TIMEOUT_MS),
    })
  } catch (error) {
    throw new StepFailure(`could not download ${step.url}: ${(error as Error).message}`)
  }
  if (!response.ok) throw new StepFailure(`${step.url} answered HTTP ${response.status}`)
  const finalUrl = response.url === '' ? step.url : response.url
  if (!finalUrl.startsWith('https://'))
    throw new StepFailure(`${step.url} was not served over https (${finalUrl})`)
  const body = new Uint8Array(await response.arrayBuffer())
  if (body.length === 0) throw new StepFailure(`${step.url} returned an empty body`)
  if (body.length > KEY_SIZE_LIMIT)
    throw new StepFailure(`${step.url} returned ${body.length} bytes, too many for a key`)

  let binary: Uint8Array
  let fingerprints: string[]
  try {
    binary = dearmorPublicKey(Buffer.from(body).toString('utf8'))
    fingerprints = primaryKeyFingerprints(binary)
  } catch (error) {
    throw new StepFailure(`${step.url} did not return a usable key: ${(error as Error).message}`)
  }
  // Every primary key in the file must be one we pinned: an extra key would be trusted by apt/dnf too.
  if (
    fingerprints.length === 0 ||
    fingerprints.some((fingerprint) => !step.fingerprints.includes(fingerprint))
  )
    throw new StepFailure(
      `${step.url} served key ${fingerprints.join(', ') || '(none)'}, expected ${step.fingerprints.join(', ')}`
    )
  await context.deps.writeFile(step.path, step.encoding === 'binary' ? binary : body, step.mode)
  return { status: 'applied', detail: `wrote ${step.path} (key ${fingerprints.join(', ')})` }
}

async function writeSource(
  context: RunContext,
  step: Extract<HostRecipeStep, { kind: 'write-source' }>
): Promise<StepDone> {
  const wanted = Buffer.from(step.content, 'utf8')
  const existing = await context.deps.readFile(step.path)
  if (existing !== null) {
    // Someone's own repository configuration is theirs; it is never overwritten.
    return bytesEqual(existing, wanted)
      ? { status: 'satisfied', detail: `${step.path} is already in place` }
      : { status: 'satisfied', detail: `kept the existing ${step.path}, which differs from the recipe's` }
  }
  await context.deps.writeFile(step.path, wanted, step.mode)
  return { status: 'applied', detail: `wrote ${step.path}` }
}

/**
 * Whether a package of exactly `query.package`'s name is installed. Only the package manager's own
 * "not installed" answer means no (the recipe runs it with `LC_ALL=C`, so the wording is fixed).
 * Anything else — an rpm database it cannot open, a lock, a command that did not run, a reply this
 * does not recognise — fails the step: read as "absent", it would let a conflict slip past the
 * checks before an install.
 */
async function isInstalled(
  context: RunContext,
  query: { package: string; argv: string[] }
): Promise<boolean> {
  const output = await run(context, query.argv)
  const stdout = output.stdout.trim()
  const stderr = output.stderr.trim()
  if (query.argv[0] === 'rpm') {
    // `rpm --query --queryformat=%{NAME}\n <name>`: the name once per installed version, or exit 1
    // with "package <name> is not installed" on stdout and nothing on stderr.
    if (
      output.code === 0 &&
      stdout !== '' &&
      stdout.split('\n').every((line) => line.trim() === query.package)
    )
      return true
    if (output.code === 1 && stderr === '' && stdout === `package ${query.package} is not installed`)
      return false
  } else {
    // `dpkg-query --show --showformat=${Status} <name>`: "<want> <error> <status>" for a package dpkg
    // knows (installed only when the status is `installed`), or exit 1 and "no packages found
    // matching <name>" on stderr for one it has never seen.
    if (output.code === 0 && stdout !== '') return stdout.split(/\s+/).pop() === 'installed'
    if (
      output.code === 1 &&
      stdout === '' &&
      stderr === `dpkg-query: no packages found matching ${query.package}`
    )
      return false
  }
  throw new StepFailure(`could not tell whether ${query.package} is installed`, output.code, output.stderr)
}

async function installPackages(
  context: RunContext,
  step: Extract<HostRecipeStep, { kind: 'install-packages' }>
): Promise<StepDone> {
  const missing: string[] = []
  for (const query of step.queries) if (!(await isInstalled(context, query))) missing.push(query.package)
  if (missing.length === 0)
    return { status: 'satisfied', detail: `${step.packages.join(', ')} already installed` }

  // A component with something left to install could remove or replace what it conflicts with.
  const { packages } = INSTALL_CONTAINER_RUNTIME_RECIPE
  const installing = (component: 'docker-engine' | 'nvidia-container-toolkit') =>
    missing.some((name) => packages[component].includes(name))
  for (const conflict of step.conflicts) {
    if (installing(conflict.component) && (await isInstalled(context, conflict)))
      throw new StepFailure(
        `${conflict.package} is installed, and installing ${packages[conflict.component].join(', ')} would ` +
          'remove or replace it. Nothing was installed and nothing was removed.'
      )
  }
  if (step.obsoletes !== null) await refuseObsoletedPackages(context, step.obsoletes, missing)
  for (const refresh of step.refresh) await mustRun(context, refresh)
  await mustRun(context, [...step.install, ...missing], { longRunning: true })
  return { status: 'applied', detail: `installed ${missing.join(', ')}` }
}

/**
 * dnf honours RPM `Obsoletes` on every install and no option turns that off, so before installing,
 * ask the configured repositories what each missing package obsoletes and refuse if a package of
 * any of those names is installed. By name only: libsolv matches Obsoletes against package names,
 * never against what a package provides. Nothing is installed or removed here, but `dnf repoquery`
 * refreshes dnf's metadata cache and, with `-y`, accepts repository signing keys the install would
 * accept too (see the recipe's `dnf.obsoletes`). Only the recipe's own packages are asked about,
 * not the dependencies the install pulls in.
 */
async function refuseObsoletedPackages(
  context: RunContext,
  obsoletes: NonNullable<Extract<HostRecipeStep, { kind: 'install-packages' }>['obsoletes']>,
  missing: string[]
): Promise<void> {
  for (const query of obsoletes.queries) {
    if (!missing.includes(query.package)) continue
    const answer = await run(context, query.argv)
    if (answer.code !== 0)
      throw new StepFailure(
        `could not ask the repositories what ${query.package} obsoletes`,
        answer.code,
        answer.stderr
      )
    const names = new Set<string>()
    for (const line of answer.stdout.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      // "name <= version": the name is the first word; the constraint is dropped, so an installed
      // package of that name counts whatever its version.
      const name = trimmed.split(/\s+/)[0]!
      if (!isPackageName(name))
        throw new StepFailure(
          `dnf repoquery printed ${JSON.stringify(trimmed.slice(0, 80))} for ${query.package}, which is not a package name`
        )
      names.add(name)
    }
    for (const name of names) {
      if (await isInstalled(context, { package: name, argv: [...obsoletes.installed, name] }))
        throw new StepFailure(
          `${name} is installed, and installing ${query.package} would replace it (RPM Obsoletes). ` +
            'Nothing was installed and nothing was removed.'
        )
    }
  }
}

const registersNvidia = (bytes: Uint8Array | null): boolean => {
  if (bytes === null) return false
  try {
    const json = JSON.parse(Buffer.from(bytes).toString('utf8')) as { runtimes?: Record<string, unknown> }
    return typeof json.runtimes === 'object' && json.runtimes !== null && 'nvidia' in json.runtimes
  } catch {
    return false
  }
}

async function dockerLoadedNvidia(context: RunContext, argv: string[]): Promise<boolean> {
  const output = await run(context, argv)
  if (output.code !== 0) return false
  try {
    const runtimes = JSON.parse(output.stdout) as Record<string, unknown>
    return typeof runtimes === 'object' && runtimes !== null && 'nvidia' in runtimes
  } catch {
    return false
  }
}

/**
 * `nvidia-ctk runtime configure`, and a Docker restart only when it is both needed and allowed.
 *
 * Needed: the running daemon has not loaded the runtime — because `nvidia-ctk` just changed
 * daemon.json, or because daemon.json already registered it and Docker was never restarted.
 * Allowed: the plan listed the restart and the user consented to it (design D5), or Docker was not
 * running before this run began — then the only daemon to restart is the one the package install
 * just started, with no containers of the user's to stop.
 */
async function configureRuntime(
  context: RunContext,
  step: Extract<HostRecipeStep, { kind: 'configure-runtime' }>
): Promise<StepDone> {
  const before = await context.deps.readFile(step.daemon_json)
  const registered = registersNvidia(before)
  let changed = false
  if (!registered) {
    await mustRun(context, step.configure)
    changed = !bytesEqual(before, await context.deps.readFile(step.daemon_json))
  }
  const active = (await run(context, step.docker_active)).code === 0
  if (!active) {
    return registered
      ? { status: 'satisfied', detail: 'the NVIDIA runtime is already registered; Docker is not running' }
      : {
          status: 'applied',
          detail: `registered the NVIDIA runtime; Docker is not running, it loads it on start`,
        }
  }
  if (!changed && (!registered || (await dockerLoadedNvidia(context, step.loaded)))) {
    return registered
      ? { status: 'satisfied', detail: 'the NVIDIA runtime is already registered and loaded' }
      : {
          status: 'applied',
          detail: `nvidia-ctk left ${step.daemon_json} unchanged; Docker was not restarted`,
        }
  }
  if (!step.restart_approved && context.dockerActiveAtStart) {
    return {
      status: registered ? 'satisfied' : 'applied',
      detail:
        'Docker was not restarted: the approved plan did not include a restart. The NVIDIA runtime loads at its next start.',
    }
  }
  await resetFailed(context, step.reset_failed)
  await mustStartDocker(context, step.restart, step.journal)
  return {
    status: 'applied',
    detail: changed
      ? 'registered the NVIDIA runtime and restarted Docker'
      : 'restarted Docker to load the registered NVIDIA runtime',
  }
}

/**
 * The NVIDIA CDI spec (task 2.23, F-5). Satisfied when `nvidia-ctk cdi list` already names a
 * `nvidia.com/gpu` device — whichever spec defines it — so a replay writes nothing. Otherwise
 * `nvidia-ctk cdi generate` writes the one fixed path, and the list is asked again: a generate that
 * exits 0 but leaves no device (no driver the toolkit can read) fails the step here, not at the GPU
 * check after the image pull.
 *
 * Then the spec's mode: the core's probe lists the devices as the user, so a spec this step's path
 * holds must be readable by others. `stat` reads the mode and `chmod 0644` runs only when it is not
 * (review round 1: whether `generate` leaves it `0644` differs across toolkit releases).
 *
 * Then `nvidia-cdi-refresh.path`, only where the toolkit ships it (see `enableCdiRefresh`). Its
 * absence, or a failed enable, never fails the step — the spec is there now, and a probe after a
 * reboot that lost it plans it again (ruling R-core-8); the detail says which it was.
 */
async function generateCdi(
  context: RunContext,
  step: Extract<HostRecipeStep, { kind: 'generate-cdi' }>
): Promise<StepDone> {
  const listsGpu = async (): Promise<boolean> => {
    const listed = await run(context, step.list)
    return listed.code === 0 && /nvidia\.com\/gpu/i.test(listed.stdout)
  }
  let generated = false
  if (!(await listsGpu())) {
    await mustRun(context, step.generate)
    if (!(await listsGpu()))
      throw new StepFailure(
        `${step.generate.join(' ')} finished, but nvidia-ctk cdi list still names no nvidia.com/gpu device`
      )
    generated = true
  }
  const readable = await makeSpecReadable(context, step)
  const refresh = await enableCdiRefresh(context, step)
  const spec = generated ? `generated ${step.spec}` : 'an NVIDIA CDI device is already defined'
  return {
    status: generated || readable.changed || refresh.changed ? 'applied' : 'satisfied',
    detail: [spec, ...(readable.detail === null ? [] : [readable.detail]), refresh.detail].join('; '),
  }
}

/**
 * `chmod 0644` of the spec at the step's path, only when `stat` shows it lacks the read bit for
 * others. No file there (the device comes from another spec) is nothing to do; a mode `stat` cannot
 * give, or a failed `chmod`, fails the step: the probe would not see the device the step just wrote.
 */
async function makeSpecReadable(
  context: RunContext,
  step: Extract<HostRecipeStep, { kind: 'generate-cdi' }>
): Promise<{ changed: boolean; detail: string | null }> {
  if ((await context.deps.readFile(step.spec)) === null) return { changed: false, detail: null }
  const stat = await run(context, step.mode)
  const mode = /^[0-7]{3,4}$/.test(stat.stdout.trim()) ? Number.parseInt(stat.stdout.trim(), 8) : null
  if (stat.code !== 0 || mode === null)
    throw new StepFailure(`could not read the mode of ${step.spec}`, stat.code, stat.stderr)
  if ((mode & 0o004) !== 0) return { changed: false, detail: null }
  await mustRun(context, step.make_readable)
  return { changed: true, detail: `made ${step.spec} readable (was ${mode.toString(8)})` }
}

/**
 * What `systemctl is-enabled` prints, by what it means here (systemd's own table). Enabled in any
 * form — or a unit that cannot be enabled directly (`static`, `indirect`, `generated`, `transient`,
 * an `alias`) — is left alone; only `disabled` and `linked` get `enable --now`; `masked` is the
 * administrator's choice and is never undone; anything else is reported and left alone.
 */
const REFRESH_LEAVE: ReadonlySet<string> = new Set([
  'enabled',
  'enabled-runtime',
  'static',
  'indirect',
  'generated',
  'transient',
  'alias',
])
const REFRESH_ENABLE: ReadonlySet<string> = new Set(['disabled', 'linked', 'linked-runtime'])

/** `nvidia-cdi-refresh.path`, only where the toolkit (1.18+) ships it; never fails the step. */
async function enableCdiRefresh(
  context: RunContext,
  step: Extract<HostRecipeStep, { kind: 'generate-cdi' }>
): Promise<{ changed: boolean; detail: string }> {
  const unit = step.refresh_unit
  const present = await run(context, step.refresh_present)
  if (present.code !== 0 || !present.stdout.includes(unit))
    return { changed: false, detail: `${unit} is not installed, so the spec is not refreshed automatically` }
  const state = (await run(context, step.refresh_enabled)).stdout.trim().split('\n')[0]?.trim() ?? ''
  if (REFRESH_LEAVE.has(state)) return { changed: false, detail: `${unit} is already ${state}` }
  if (!REFRESH_ENABLE.has(state))
    return { changed: false, detail: `${unit} is ${state || 'in an unknown state'}; left as it is` }
  const enable = await run(context, step.refresh_enable)
  if (enable.code !== 0)
    return {
      changed: false,
      detail: `${unit} could not be enabled (exit ${String(enable.code)}): ${tail(enable.stderr) || 'no output'}`,
    }
  return { changed: true, detail: `enabled ${unit}` }
}

async function enableService(
  context: RunContext,
  step: Extract<HostRecipeStep, { kind: 'enable-service' }>
): Promise<StepDone> {
  const enabled = await run(context, step.enabled)
  const active = await run(context, step.active)
  if (enabled.code === 0 && enabled.stdout.trim() === 'enabled' && active.code === 0)
    return { status: 'satisfied', detail: 'docker.service is already enabled and running' }
  await resetFailed(context, step.reset_failed)
  await mustStartDocker(context, step.enable, step.journal)
  return { status: 'applied', detail: 'enabled and started docker.service' }
}

async function addToDockerGroup(
  context: RunContext,
  step: Extract<HostRecipeStep, { kind: 'add-to-docker-group' }>
): Promise<StepDone> {
  const id = await run(context, step.uid)
  if (id.code !== 0) throw new StepFailure(`there is no user ${step.user}`, id.code, id.stderr)
  const uid = id.stdout.trim()
  // A second name for uid 0 is still root, and root never needs the group (design D4).
  if (uid === '0') throw new StepFailure(`${step.user} is uid 0; root is never added to the docker group`)
  const invoking = context.deps.invokingUid
  if (invoking !== null && uid !== invoking)
    throw new StepFailure(`${step.user} is uid ${uid}, but elevation was requested by uid ${invoking}`)
  const groups = await run(context, step.groups)
  if (groups.code === 0 && groups.stdout.trim().split(/\s+/).includes('docker'))
    return { status: 'satisfied', detail: `${step.user} is already in the docker group` }
  await mustRun(context, step.add)
  return { status: 'applied', detail: `added ${step.user} to the docker group` }
}

async function runStep(context: RunContext, step: HostRecipeStep): Promise<StepDone> {
  switch (step.kind) {
    case 'install-key':
      return installKey(context, step)
    case 'write-source':
      return writeSource(context, step)
    case 'install-packages':
      return installPackages(context, step)
    case 'configure-runtime':
      return configureRuntime(context, step)
    case 'generate-cdi':
      return generateCdi(context, step)
    case 'enable-service':
      return enableService(context, step)
    case 'add-to-docker-group':
      return addToDockerGroup(context, step)
  }
}

function refused(echo: HostStepEcho, problems: string[], now: number): HostStepResult {
  return {
    schema_version: 1,
    step_id: echo.step_id ?? '',
    outcome: 'failed',
    exit_code: null,
    log_tail: head(`refused [MANAGED_HOST_STEP_INVALID]: ${problems.join('; ')}`),
    finished_at: now,
    nonce: echo.nonce,
    recipe_id: echo.recipe_id,
    recipe_digest: echo.recipe_digest,
    parameters_digest: echo.parameters_digest,
    error_code: 'MANAGED_HOST_STEP_INVALID',
    steps: [],
  }
}

/** Decides what to do with a request's text; runs the recipe only for a request it fully accepts. */
async function execute(text: string, fileName: string, deps: HostStepExecutorDeps): Promise<HostStepResult> {
  const parsed = parseHostStepRequest(text)
  if (!parsed.ok) return refused(parsed.echo, parsed.problems, deps.now())
  const request = parsed.request
  const echo: HostStepEcho = {
    step_id: request.step_id,
    nonce: request.nonce,
    recipe_id: request.recipe_id,
    recipe_digest: request.recipe_digest,
    parameters_digest: request.parameters_digest,
  }
  const refuse = (problem: string) => refused(echo, [problem], deps.now())

  // A request copied or renamed into another step's slot would otherwise report under that step.
  if (fileName !== `${request.step_id}.request.json`)
    return refuse(`step_id ${request.step_id} does not match the request file name ${fileName}`)
  if (request.recipe_id !== INSTALL_CONTAINER_RUNTIME_RECIPE_ID)
    return refuse(`unknown recipe ${request.recipe_id}`)
  if (request.action !== INSTALL_CONTAINER_RUNTIME_RECIPE_ID)
    return refuse(`action ${request.action} is not what recipe ${request.recipe_id} does`)
  if (request.recipe_digest !== INSTALL_CONTAINER_RUNTIME_RECIPE_DIGEST)
    return refuse(
      `recipe_digest ${request.recipe_digest} is not this build's ${INSTALL_CONTAINER_RUNTIME_RECIPE_DIGEST}`
    )
  const validation = validateInstallContainerRuntimeParameters(request.parameters)
  if (!validation.ok) return refused(echo, validation.problems, deps.now())
  const parametersDigest = installContainerRuntimeParametersDigest(validation.parameters)
  if (request.parameters_digest !== parametersDigest)
    return refuse(
      `parameters_digest ${request.parameters_digest} does not match the parameters (${parametersDigest})`
    )

  const steps = buildInstallContainerRuntimeSteps(validation.parameters)
  const context: RunContext = { deps, dockerActiveAtStart: false }
  const configure = steps.find((step) => step.kind === 'configure-runtime')
  /** Docker's state before anything changes; runs as part of the first step, so a failure is reported. */
  const recordStartingState = async (): Promise<void> => {
    if (configure !== undefined && configure.kind === 'configure-runtime')
      context.dockerActiveAtStart = (await run(context, configure.docker_active)).code === 0
  }

  const outcomes: HostStepStepOutcome[] = []
  let failure: StepFailure | null = null
  for (const [index, step] of steps.entries()) {
    if (failure !== null) {
      outcomes.push({ id: step.id, status: 'not-run', exit_code: null, stderr: '', detail: '' })
      continue
    }
    try {
      if (index === 0) await recordStartingState()
      const done = await runStep(context, step)
      outcomes.push({ id: step.id, status: done.status, exit_code: null, stderr: '', detail: done.detail })
    } catch (error) {
      failure = error instanceof StepFailure ? error : new StepFailure((error as Error).message)
      outcomes.push({
        id: step.id,
        status: 'failed',
        exit_code: failure.exitCode,
        stderr: tail(failure.stderr),
        detail: failure.message,
      })
    }
  }

  const failed = outcomes.find((outcome) => outcome.status === 'failed')
  const applied = outcomes.filter((outcome) => outcome.status === 'applied').length
  return {
    schema_version: 1,
    step_id: request.step_id,
    outcome: failed === undefined ? 'completed' : 'failed',
    exit_code: failed === undefined ? 0 : failed.exit_code,
    log_tail:
      failed === undefined
        ? `${request.recipe_id}: ${applied} step(s) applied, ${outcomes.length - applied} already in place`
        : tail(`${failed.id} failed: ${failed.detail}${failed.stderr ? `\n${failed.stderr}` : ''}`),
    finished_at: deps.now(),
    nonce: request.nonce,
    recipe_id: request.recipe_id,
    recipe_digest: request.recipe_digest,
    parameters_digest: request.parameters_digest,
    error_code: null,
    steps: outcomes,
  }
}

/**
 * Runs one host-step request and writes `<step>.result.json` beside it. This is the entry point
 * `atomic-chat-core host-step exec` and `atc host-step exec` call as root.
 *
 * Client requirement: the folder holding the request must be owned by the invoking user (named by
 * `PKEXEC_UID`/`SUDO_UID`) with mode `0700`, and the request file must be `0600` — see
 * `request-file.ts`. With `nodeHostStepDeps`, anything else is refused.
 *
 * Throws only when no result file can be written: `MANAGED_HOST_STEP_INVALID` when the path is not
 * a `*.request.json` or the folder is not trusted, or the file system's own error when the write
 * itself fails (ENOSPC, EROFS, ...). Every other problem — an unreadable request, a refused
 * request, a failed step, an unexpected error — is a `failed` result file.
 */
export async function executeHostStep(
  requestPath: string,
  deps: HostStepExecutorDeps
): Promise<HostStepResult> {
  const resultPath = resultPathFor(requestPath)
  if (resultPath === null)
    throw new AtomicCoreError(
      'MANAGED_HOST_STEP_INVALID',
      `A host-step request file must be named <step_id>.request.json: ${requestPath}`
    )
  const fileName = basename(requestPath)
  const result = await deps.readRequest(requestPath).then(
    (text) =>
      execute(text, fileName, deps).catch((error: unknown): HostStepResult => {
        // Nothing should reach here; if something does, the result file still says so.
        const nothing = {
          step_id: null,
          nonce: null,
          recipe_id: null,
          recipe_digest: null,
          parameters_digest: null,
        }
        return {
          ...refused(nothing, [], deps.now()),
          log_tail: head(`the executor stopped unexpectedly: ${(error as Error).message}`),
          error_code: null,
        }
      }),
    (error: unknown) => {
      const code =
        error instanceof AtomicCoreError
          ? error.message
          : ((error as NodeJS.ErrnoException).code ?? (error as Error).message)
      const nothing = {
        step_id: null,
        nonce: null,
        recipe_id: null,
        recipe_digest: null,
        parameters_digest: null,
      }
      return refused(nothing, [`could not read the request file (${code})`], deps.now())
    }
  )
  await deps.writeResult(resultPath, `${JSON.stringify(result, null, 2)}\n`)
  return result
}
