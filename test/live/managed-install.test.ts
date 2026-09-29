/**
 * Live installation of the managed TensorRT-LLM engine on a real Linux VM (openspec change
 * `add-tensorrt-llm-linux`, task 2.18; spec `managed-runtime-environment`, design D2–D5, D15).
 *
 * Everything else in the suite proves the setup against a folder standing in for a Linux machine
 * (`test/e2e/managed-operations.test.ts`). This file is the only proof that the plan is right for a
 * real distribution, that the recipe really installs Docker and the toolkit with apt or dnf, that the
 * relogin is detected, that a real GPU is visible in a real container, and that a curated model
 * answers on :1337 — the evidence the task's acceptance asks to attach to the PR per distribution.
 *
 * It drives the compiled core only (no `src/` imports), the way the app and `atc` do: the control
 * API for probe → begin → consent → receipt, and `sudo <core> host-step exec <request>` as the
 * privileged step (the command a person without a polkit agent runs, design D3).
 *
 * The relogin (design D4) cannot be a real logout inside a test. The first core runs in the test's
 * own session, which predates the `docker` group the recipe adds, and must stop at
 * `relogin-required` — also after an explicit resume, which re-checks. The second core is started
 * with `sudo -u <same user>`, which builds the process's groups with `initgroups(3)` from
 * `/etc/group`, the call `login`, `sshd` and display managers make when a session begins. That core
 * therefore carries the group exactly as a fresh login would, the test checks it in
 * `/proc/<pid>/status`, and it must continue the operation at startup with no resume from the test.
 * `sg docker -c` was not used: it runs a shell string and sets the primary group only. Restarting
 * under `newgrp` needs an interactive shell.
 *
 * The run reads the machine first and runs only the scenarios its starting state can exercise
 * (a clean recipe host, Docker with running containers, Fedora's `moby-engine`, a ready host,
 * Arch); the rest are skipped with the reason. Each scenario, the phase timings and the host facts
 * go to `<out>/summary.json` and `<out>/run.log`. Instructions per distribution: `docs/live-tests.md`.
 *
 * Opt in with ATOMIC_LIVE=1 and ATOMIC_LIVE_MANAGED=1 on Linux (it installs system packages with
 * sudo, so `npm run test:live` alone never starts it). Optional: ATOMIC_LIVE_CORE_BIN,
 * ATOMIC_RUNTIME_DESCRIPTOR_URL (default: the conf fixture copy in this repo), ATOMIC_LIVE_OUT,
 * ATOMIC_LIVE_MODEL_CACHE, ATOMIC_LIVE_TRT_MODEL, ATOMIC_LIVE_TRT_CONTEXT_LENGTH,
 * ATOMIC_LIVE_PUBLIC_PORT, ATOMIC_LIVE_SENTINELS, ATOMIC_LIVE_SENTINEL_IMAGE, HF_ENDPOINT, HF_TOKEN.
 * Both cores run with DO_NOT_TRACK=1: a test run sends no error reports.
 */
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pollOperation, startLiveCore, streamChat } from '../helpers/live-core.js'
import type { LiveCore, OperationView, PendingHostStep } from '../helpers/live-core.js'
import { pickCuratedModel, prepareCuratedModel, readDescriptor } from '../helpers/live-hf-model.js'
import type { CuratedModel } from '../helpers/live-hf-model.js'
import {
  cardBytes,
  daemonJsonDigest,
  detectHost,
  dockerCli,
  packageSetDigest,
  preconditionProblems,
  processGroups,
  run,
  runAsync,
  setupPath,
  sudoDocker,
} from '../helpers/live-linux-host.js'
import type { HostFacts, SetupPath } from '../helpers/live-linux-host.js'
import { LiveReport } from '../helpers/live-report.js'

const ENABLED =
  process.env['ATOMIC_LIVE'] === '1' &&
  process.env['ATOMIC_LIVE_MANAGED'] === '1' &&
  process.platform === 'linux'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const CPU = process.arch === 'arm64' ? 'aarch64' : 'x86_64'
const BIN =
  process.env['ATOMIC_LIVE_CORE_BIN'] ?? join(ROOT, 'dist/bin', `atomic-chat-core-${CPU}-unknown-linux-gnu`)
const DESCRIPTOR_URL =
  process.env['ATOMIC_RUNTIME_DESCRIPTOR_URL'] ??
  pathToFileURL(join(ROOT, 'test/fixtures/runtimes/tensorrt-llm.json')).href
const PUBLIC_PORT = Number(process.env['ATOMIC_LIVE_PUBLIC_PORT'] ?? 1337)
const CONTEXT_LENGTH = process.env['ATOMIC_LIVE_TRT_CONTEXT_LENGTH']
  ? Number(process.env['ATOMIC_LIVE_TRT_CONTEXT_LENGTH'])
  : null
const SENTINELS = Number(process.env['ATOMIC_LIVE_SENTINELS'] ?? 2)
const SENTINEL_IMAGE = process.env['ATOMIC_LIVE_SENTINEL_IMAGE'] ?? 'busybox:1.36'
const RECIPE_ID = 'linux.install-container-runtime'
const TARGET = { kind: 'runtime', installation_id: 'tensorrt-llm', engine_id: 'tensorrt-llm' } as const
const MIN = 60_000
const HOUR = 60 * MIN

/** Every system change the plan may name (design D2): nothing about drivers, removals or upgrades. */
const KNOWN_CHANGES = [
  'add-repository',
  'install-packages',
  'configure-nvidia-runtime',
  'enable-docker-service',
  'add-user-to-docker-group',
  'restart-docker',
]

const SCENARIOS = [
  [
    'preconditions',
    'the VM can run this test: Linux, a normal user with passwordless sudo, a GPU and driver the descriptor accepts',
  ],
  ['probe-plan', 'probe: the plan fits the machine, and probing changed nothing on it'],
  [
    'install-from-clean',
    'recipe host without Docker: repositories, packages, toolkit, runtime, service and docker group in the plan',
  ],
  [
    'toolkit-only-plan',
    "distribution Docker (Fedora's moby-engine, Debian/Ubuntu docker.io): the plan installs only nvidia-container-toolkit",
  ],
  [
    'arch-blocked',
    'Arch with something missing: prerequisite-blocked with exact pacman commands, no install plan',
  ],
  [
    'consent-gates-work',
    'while the operation awaits consent nothing is elevated, pulled, installed or restarted',
  ],
  [
    'privileged-step',
    'the pending step runs as `sudo <core> host-step exec <request>`; its receipt is accepted',
  ],
  [
    'restart-with-consent',
    'Docker already running containers: the plan names the restart and the count; it happens only after consent',
  ],
  [
    'relogin',
    'relogin-required in the old session (also after a resume); a core with a fresh login group set continues by itself',
  ],
  [
    'gpu-pull-ready',
    'GPU check in a container → engine image pulled by digest with byte progress → verified → ready',
  ],
  ['adopt-ready-host', 'ready host: adopted with no elevation, no system change and no host step'],
  ['arch-adopt', 'Arch with Docker and the toolkit installed by hand: adopted like any ready host'],
  ['post-ready-probe-noop', 'a probe after ready: adopt, nothing to change'],
  [
    'recipe-rerun-noop',
    'the same recipe request run again: every step already satisfied, no package, config or Docker change',
  ],
  [
    'model-chat',
    'a curated model for this GPU tier loads through the tensorrt-llm provider and streams a chat answer on :1337',
  ],
  [
    'selinux-no-permission-denied',
    "SELinux enforcing: the core reports the daemon's SELinux, labels mounts :z when it does, and nothing is denied",
  ],
] as const
type ScenarioId = (typeof SCENARIOS)[number][0]

interface Descriptor {
  descriptor_id: string
  minimum_driver_version: string
  minimum_compute_capability: string
  image: Record<string, { repository: string; digest: string }>
  probe_image: Record<string, { repository: string; digest: string }>
  curated_models: CuratedModel[]
  recipes: Array<{
    recipe_id: string
    distributions: Array<{ id: string; version_id: string; arch: string }>
  }>
}

interface SystemChange {
  code: string
  text: string
  params?: Record<string, string>
}

interface Plan {
  plan_digest: string
  availability: string
  recipe_id: string
  descriptor_id: string | null
  image_digest: string | null
  adopts_existing_engine: boolean
  system_changes: SystemChange[]
  requires_elevation: boolean
  may_require_relogin: boolean
  blockers: Array<{ code: string; message: string; reason?: string; commands?: string[] }>
}

interface HostStepResult {
  outcome: 'completed' | 'failed'
  log_tail: string
  error_code: string | null
  steps: Array<{ id: string; status: string; detail: string; stderr: string }>
}

/** Everything the scenarios hand each other, in file order. */
const S: {
  descriptor: Descriptor
  facts: HostFacts
  path: SetupPath
  problems: string[]
  out: string
  dataFolder: string
  hostSteps: string
  coreEnv: Record<string, string>
  core: LiveCore | null
  closeEvents: (() => void) | null
  plan: Plan | null
  operationId: string | null
  approved: boolean
  afterStep: OperationView | null
  requestFile: string | null
  sentinels: string[]
  dockerPidAtProbe: string | null
  consentEvidence: Record<string, unknown> | null
  stepEvidence: {
    pidBefore: string | null
    pidAfter: string | null
    sentinelsRunning: boolean[]
    configure: string
  } | null
  engineImagePresentBefore: boolean
  pullBytes: number
  ready: boolean
  modelId: string | null
  modelLoadStartedAt: number
  containerId: string | null
} = {
  descriptor: undefined as unknown as Descriptor,
  facts: undefined as unknown as HostFacts,
  path: 'unsupported',
  problems: [],
  out: '',
  dataFolder: '',
  hostSteps: '',
  coreEnv: {},
  core: null,
  closeEvents: null,
  plan: null,
  operationId: null,
  approved: false,
  afterStep: null,
  requestFile: null,
  sentinels: [],
  dockerPidAtProbe: null,
  consentEvidence: null,
  stepEvidence: null,
  engineImagePresentBefore: false,
  pullBytes: 0,
  ready: false,
  modelId: null,
  modelLoadStartedAt: 0,
  containerId: null,
}
let report: LiveReport

const platformKey = (): string => (S.facts.arch === 'aarch64' ? 'linux/arm64' : 'linux/amd64')
const engineRef = (): string => {
  const image = S.descriptor.image[platformKey()]
  return `${image?.repository}@${image?.digest}`
}
const dockerPid = (): string | null => {
  const out = run('systemctl', ['show', '-p', 'MainPID', '--value', 'docker'])
  const pid = out.stdout.trim()
  return out.code === 0 && pid !== '' && pid !== '0' ? pid : null
}
const containerRunning = (id: string): boolean =>
  sudoDocker(['inspect', '-f', '{{.State.Running}}', id]).stdout.trim() === 'true'
const change = (code: string, vendor?: string): SystemChange | undefined =>
  S.plan?.system_changes.find(
    (c) => c.code === code && (vendor === undefined || c.params?.['vendor'] === vendor)
  )
const gpuRuntimeBefore = (): boolean => S.facts.docker.nvidia_runtime_loaded || S.facts.docker.nvidia_cdi
const restartApplies = (): boolean =>
  (S.path === 'complete' || S.path === 'install') && S.facts.docker.service_active && !gpuRuntimeBefore()
const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** A 0700 folder the invoking user owns — what `host-step exec` trusts (request-file.ts). */
function privateDir(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  chmodSync(path, 0o700)
  return path
}

async function startCore(label: string, freshLoginAs?: string): Promise<LiveCore> {
  const core = await startLiveCore({
    label,
    bin: BIN,
    dataFolder: S.dataFolder,
    env: S.coreEnv,
    logFile: join(S.out, 'core.log'),
    ...(freshLoginAs === undefined ? {} : { freshLoginAs }),
  })
  report.log(
    `core ${label} ready: pid ${core.ready.pid}, version ${core.ready.version}, control :${core.ready.control_port}`
  )
  const events = core.api.events((event, data) => {
    if (event === 'environment:operation') record(label, data as OperationView)
  })
  S.closeEvents = events.close
  S.core = core
  return core
}

/**
 * One view of the operation into the phase log, from the event stream or from a poll: two sources,
 * so a dropped stream or a frame still in flight when a poll already sees `ready` loses nothing.
 */
function record(label: string, op: OperationView): void {
  if (op.operation_id !== S.operationId && S.operationId !== null) return
  report.phase(label, op.phase, op.revision, op.progress)
  if (op.phase === 'pulling-image' && op.progress?.unit === 'bytes')
    S.pullBytes = Math.max(S.pullBytes, op.progress.completed ?? 0)
}

/** `pollOperation` with every view recorded under the running core's label. */
const poll = (
  api: LiveCore['api'],
  operationId: string,
  done: (operation: OperationView) => boolean,
  timeoutMs: number
): Promise<OperationView> =>
  pollOperation(api, operationId, done, timeoutMs, (op) => record(S.core?.label ?? 'unknown', op))

async function stopCore(): Promise<void> {
  S.closeEvents?.()
  S.closeEvents = null
  await S.core?.stop()
  S.core = null
}

const core = (): LiveCore => {
  if (S.core === null) throw new Error('no core is running')
  return S.core
}

async function probe(): Promise<Plan> {
  const answer = await core().api.post<Plan>('/environments/probe', {
    descriptor_id: S.descriptor.descriptor_id,
    target: TARGET,
  })
  expect(answer.status, answer.text).toBe(200)
  return answer.body
}

/** Runs the privileged executor on one request file as root; returns its result file. */
async function execHostStep(
  requestFile: string
): Promise<{ exit: number | null; result: HostStepResult | null; stderr: string }> {
  const started = Date.now()
  const out = await runAsync('sudo', ['-n', BIN, 'host-step', 'exec', requestFile, '--json'], 3 * HOUR)
  report.log(`host-step exec exited ${out.code} after ${((Date.now() - started) / 1000).toFixed(1)} s`)
  const resultFile = requestFile.replace(/\.request\.json$/, '.result.json')
  const result = existsSync(resultFile)
    ? (JSON.parse(readFileSync(resultFile, 'utf8')) as HostStepResult)
    : null
  return { exit: out.code, result, stderr: out.stderr }
}

/** Registers one scenario: skipped with its reason, or timed and recorded as passed or failed. */
function scenario(
  id: ScenarioId,
  timeoutMs: number,
  skipReason: () => string | null,
  body: () => Promise<void>
): void {
  const title = SCENARIOS.find(([key]) => key === id)?.[1] ?? id
  it(
    `${id}: ${title}`,
    async (ctx) => {
      const reason = S.problems.length > 0 && id !== 'preconditions' ? 'preconditions not met' : skipReason()
      if (reason !== null) {
        report.finish(id, 'skipped', reason, null)
        ctx.skip(reason)
      }
      const started = Date.now()
      try {
        await body()
        report.finish(id, 'passed', null, Date.now() - started)
      } catch (error) {
        report.finish(id, 'failed', describeError(error), Date.now() - started)
        throw error
      }
    },
    timeoutMs
  )
}

const needsOperation = (): string | null =>
  S.path === 'arch-blocked' || S.path === 'unsupported'
    ? `setup path is ${S.path}: no setup operation can run on this host`
    : S.core === null
      ? 'no core is running (an earlier scenario failed)'
      : null
/** The step added this user to `docker`, and the test's session did not carry the group before. */
const reloginExpected = (): boolean =>
  change('add-user-to-docker-group') !== undefined && !S.facts.groups_effective.includes('docker')
const needsReady = (): string | null =>
  S.ready ? null : 'the setup did not reach ready (see gpu-pull-ready)'
const needsApproval = (): string | null =>
  needsOperation() ?? (S.approved ? null : 'the setup was not approved (see consent-gates-work)')
/** Past the privileged part: adopt needs none; otherwise the step and, if asked for, the relogin. */
const needsHostPrepared = (): string | null =>
  needsApproval() ??
  (S.path === 'adopt'
    ? null
    : S.afterStep === null
      ? 'the privileged step did not complete (see privileged-step)'
      : S.afterStep.phase === 'relogin-required' && report.status('relogin') !== 'passed'
        ? 'the relogin did not complete (see relogin)'
        : null)

describe.skipIf(!ENABLED)('managed TensorRT-LLM install on a real Linux VM (task 2.18)', () => {
  beforeAll(async () => {
    S.descriptor = await readDescriptor<Descriptor>(DESCRIPTOR_URL)
    S.facts = detectHost(S.descriptor)
    S.path = setupPath(S.facts)
    S.problems = preconditionProblems(S.facts, S.descriptor)
    if (!existsSync(BIN)) S.problems.push(`no core binary at ${BIN} (build it or set ATOMIC_LIVE_CORE_BIN)`)
    if (S.path === 'unsupported')
      S.problems.push(
        `${S.facts.os.id} ${S.facts.os.version_id ?? ''} ${S.facts.arch} is neither on the descriptor's recipe list nor Arch, ` +
          'and Docker with a GPU runtime is not ready for this user: there is no setup path to test here'
      )
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const name = `${S.facts.os.id || 'linux'}-${S.facts.os.version_id ?? 'rolling'}-${S.facts.arch}-${stamp}`
    S.out = process.env['ATOMIC_LIVE_OUT'] ?? join(ROOT, 'test/tmp/live-managed-install', name)
    report = new LiveReport(S.out, SCENARIOS)
    S.dataFolder = join(S.out, 'data')
    mkdirSync(S.dataFolder, { recursive: true })
    S.hostSteps = privateDir(join(S.out, 'host-steps'))
    S.coreEnv = {
      ATOMIC_CORE_MANAGED_ROOT: join(S.out, 'managed'),
      ATOMIC_RUNTIME_DESCRIPTOR_URL: DESCRIPTOR_URL,
      HOME: homedir(),
      // Both cores alike: the relogin core goes through sudo's env_reset, which would drop what the
      // first one inherits. No error reports from a test run, and the runtime dir a login has.
      DO_NOT_TRACK: '1',
      XDG_RUNTIME_DIR: process.env['XDG_RUNTIME_DIR'] ?? `/run/user/${S.facts.uid}`,
    }
    const version = run(BIN, ['--version'])
    report.section('core', {
      binary: BIN,
      version: version.stdout.trim(),
      sha256: existsSync(BIN) ? createHash('sha256').update(readFileSync(BIN)).digest('hex') : null,
      git_head: run('git', ['-C', ROOT, 'rev-parse', 'HEAD']).stdout.trim() || null,
    })
    report.section('descriptor', {
      url: DESCRIPTOR_URL,
      descriptor_id: S.descriptor.descriptor_id,
      minimum_driver_version: S.descriptor.minimum_driver_version,
      engine_image: engineRef(),
    })
    report.section('host', { ...S.facts, setup_path: S.path })
    report.log(`output folder ${S.out}`)
    report.log(
      `host: ${S.facts.os.pretty_name} (${S.facts.os.id} ${S.facts.os.version_id ?? '-'}), ${S.facts.arch}, kernel ${S.facts.kernel}`
    )
    for (const gpu of S.facts.gpus)
      report.log(
        `gpu: ${gpu.name} ${gpu.uuid} cc ${gpu.compute_capability} ${gpu.total_bytes === null ? 'unified memory' : `${(gpu.total_bytes / 1024 ** 3).toFixed(1)} GiB`}, driver ${gpu.driver_version}`
      )
    report.log(
      `docker: cli ${S.facts.docker.cli ?? 'none'}, package ${S.facts.docker.package ?? 'none'}, ` +
        `active ${S.facts.docker.service_active}, reachable by ${S.facts.user} ${S.facts.docker.user_reaches_daemon}, ` +
        `running containers ${S.facts.docker.running_containers ?? '-'}, nvidia runtime ${gpuRuntimeBefore()}, ` +
        `toolkit ${S.facts.toolkit_installed}; selinux ${S.facts.selinux ?? 'absent'}; in recipe ${S.facts.in_recipe}; path ${S.path}`
    )
  }, 10 * MIN)

  afterAll(async () => {
    if (report === undefined) return
    if (S.core !== null && S.modelId !== null)
      await S.core.api.post(`/models/tensorrt-llm/${S.modelId}/unload`, {}, 5 * MIN).catch(() => undefined)
    await stopCore().catch(() => undefined)
    for (const id of S.sentinels) sudoDocker(['rm', '-f', id])
    report.flush()
    report.log(`\n${report.table()}`)
  }, 15 * MIN)

  scenario(
    'preconditions',
    2 * MIN,
    () => null,
    async () => {
      expect(S.problems, S.problems.join('; ')).toEqual([])
    }
  )

  scenario(
    'probe-plan',
    20 * MIN,
    () => (S.path === 'unsupported' ? 'distribution not on the recipe list and not Arch' : null),
    async () => {
      if (restartApplies() && SENTINELS > 0) {
        // Containers of "someone else's" that a Docker restart stops — the reason consent exists (D5).
        for (let i = 0; i < SENTINELS; i++) {
          const started = sudoDocker(
            ['run', '-d', '--label', 'atomic-live-sentinel=1', SENTINEL_IMAGE, 'sleep', '86400'],
            10 * MIN
          )
          expect(started.code, started.stderr).toBe(0)
          S.sentinels.push(started.stdout.trim())
        }
        report.log(`started ${S.sentinels.length} sentinel container(s) from ${SENTINEL_IMAGE}`)
      }
      S.engineImagePresentBefore =
        dockerCli() !== null && sudoDocker(['image', 'inspect', engineRef()]).code === 0
      const before = {
        pid: dockerPid(),
        packages: packageSetDigest(S.facts.family),
        daemon: daemonJsonDigest(),
      }
      S.dockerPidAtProbe = before.pid
      await startCore('first')
      const plan = await probe()
      S.plan = plan
      report.detail('probe-plan', 'plan', plan)
      report.log(
        `plan: availability ${plan.availability}, adopt ${plan.adopts_existing_engine}, elevation ${plan.requires_elevation}`
      )
      for (const c of plan.system_changes) report.log(`  change ${c.code}: ${c.text}`)
      for (const b of plan.blockers) report.log(`  blocker ${b.reason ?? b.code}: ${b.message}`)

      expect(plan.recipe_id).toBe(RECIPE_ID)
      expect(plan.descriptor_id).toBe(S.descriptor.descriptor_id)
      expect(plan.image_digest).toBe(S.descriptor.image[platformKey()]?.digest)
      for (const c of plan.system_changes)
        expect(KNOWN_CHANGES, `unexpected system change ${c.code}`).toContain(c.code)
      if (S.path === 'adopt') {
        expect(plan).toMatchObject({
          adopts_existing_engine: true,
          requires_elevation: false,
          system_changes: [],
        })
        expect(['setup-required', 'supported']).toContain(plan.availability)
      } else if (S.path === 'arch-blocked') {
        expect(plan).toMatchObject({
          availability: 'prerequisite-blocked',
          requires_elevation: false,
          system_changes: [],
        })
      } else {
        expect(plan).toMatchObject({
          availability: 'setup-required',
          requires_elevation: true,
          may_require_relogin: true,
        })
        expect(plan.blockers).toEqual([])
      }
      // Probing is read-only: no package, Docker configuration or daemon changed.
      const after = {
        pid: dockerPid(),
        packages: packageSetDigest(S.facts.family),
        daemon: daemonJsonDigest(),
      }
      expect(after).toEqual(before)
    }
  )

  scenario(
    'install-from-clean',
    5 * MIN,
    () => (S.path === 'install' ? null : `setup path is ${S.path}; needs a recipe VM without Docker`),
    async () => {
      expect(change('add-repository', 'docker')?.params?.['family']).toBe(S.facts.family)
      // The NVIDIA repository and package come only with a missing toolkit, never both ways.
      if (S.facts.toolkit_installed) expect(change('add-repository', 'nvidia')).toBeUndefined()
      else expect(change('add-repository', 'nvidia')?.params?.['family']).toBe(S.facts.family)
      expect(change('install-packages')?.params?.['packages']).toBe(
        [
          'docker-ce',
          'docker-ce-cli',
          'containerd.io',
          ...(S.facts.toolkit_installed ? [] : ['nvidia-container-toolkit']),
        ].join(',')
      )
      expect(change('configure-nvidia-runtime')).toBeDefined()
      expect(change('enable-docker-service')).toBeDefined()
      // No Docker was running, so nothing is restarted and no container of the user's stops.
      expect(change('restart-docker')).toBeUndefined()
      if (!S.facts.docker_group_members.includes(S.facts.user)) {
        const group = change('add-user-to-docker-group')
        expect(group?.params?.['user']).toBe(S.facts.user)
        expect(group?.text).toMatch(/root/i)
      }
    }
  )

  scenario(
    'toolkit-only-plan',
    5 * MIN,
    () =>
      S.path === 'complete' &&
      (S.facts.docker.package === 'moby-engine' || S.facts.docker.package === 'docker.io') &&
      !S.facts.toolkit_installed
        ? null
        : `Docker here is ${S.facts.docker.package ?? 'absent'}, toolkit ${S.facts.toolkit_installed ? 'installed' : 'absent'}; needs moby-engine (Fedora) or docker.io without the toolkit`,
    async () => {
      report.detail('toolkit-only-plan', 'docker_package', S.facts.docker.package)
      expect(change('install-packages')?.params?.['packages']).toBe('nvidia-container-toolkit')
      expect(change('add-repository', 'docker')).toBeUndefined()
      expect(change('add-repository', 'nvidia')).toBeDefined()
      expect(change('configure-nvidia-runtime')).toBeDefined()
    }
  )

  scenario(
    'arch-blocked',
    5 * MIN,
    () => (S.path === 'arch-blocked' ? null : `not an Arch host with something missing (path ${S.path})`),
    async () => {
      const commands = (S.plan?.blockers ?? []).flatMap((b) => b.commands ?? [])
      report.detail('arch-blocked', 'commands', commands)
      expect(S.plan?.blockers.length).toBeGreaterThan(0)
      expect(commands.some((c) => /pacman -Syu/.test(c))).toBe(true)
    }
  )

  scenario('consent-gates-work', 20 * MIN, needsOperation, async () => {
    const begin = await core().api.post<OperationView>('/environments/default/operations', {
      request_id: `live-${randomUUID()}`,
      target: TARGET,
      kind: 'setup',
      descriptor_id: S.descriptor.descriptor_id,
    })
    expect([200, 201, 202], begin.text).toContain(begin.status)
    S.operationId = begin.body.operation_id
    report.log(`operation ${S.operationId}`)
    const asking = await poll(
      core().api,
      S.operationId,
      (o) => o.phase === 'awaiting-consent' || o.phase === 'failed',
      15 * MIN
    )
    expect(asking.phase, JSON.stringify(asking.error)).toBe('awaiting-consent')
    expect(asking.pending_host_step).toBeNull()

    // Dwell in the consent dialog: the core must not start anything on its own.
    await new Promise((resolve) => setTimeout(resolve, 15_000))
    const still = await poll(core().api, S.operationId, () => true, MIN)
    const evidence = {
      phase: still.phase,
      pending_host_step: still.pending_host_step,
      docker_pid_at_probe: S.dockerPidAtProbe,
      docker_pid_while_waiting: dockerPid(),
      sentinels_running: S.sentinels.map(containerRunning),
      engine_image_present: dockerCli() !== null && sudoDocker(['image', 'inspect', engineRef()]).code === 0,
    }
    S.consentEvidence = evidence
    report.detail('consent-gates-work', 'evidence', evidence)
    expect(still.phase).toBe('awaiting-consent')
    expect(still.pending_host_step).toBeNull()
    expect(evidence.docker_pid_while_waiting).toBe(S.dockerPidAtProbe)
    expect(evidence.sentinels_running.every(Boolean)).toBe(true)
    expect(evidence.engine_image_present).toBe(S.engineImagePresentBefore)

    // Consent to the plan on offer. If the host moved between the offer and the click (free space,
    // a container started), the core re-probes, re-offers with MANAGED_PLAN_CHANGED, and the test
    // consents to the new plan — at most twice, then it is a failure worth reading.
    let offered = still
    for (let attempt = 0; ; attempt++) {
      const approval = await core().api.post(`/environments/operations/${S.operationId}/resume`, {
        expected_revision: offered.revision,
        approved_plan_digest: offered.plan_digest,
      })
      expect(approval.status, approval.text).toBe(200)
      const next = await poll(
        core().api,
        S.operationId,
        (o) => o.revision > offered.revision && o.phase !== 'checking',
        15 * MIN
      )
      if (next.phase === 'awaiting-consent' && next.error?.code === 'MANAGED_PLAN_CHANGED' && attempt < 2) {
        report.log(`the plan changed before the consent landed; approving the re-offered ${next.plan_digest}`)
        report.detail('consent-gates-work', `re_offered_${attempt + 1}`, next)
        offered = next
        continue
      }
      expect(next.phase, JSON.stringify(next.error)).not.toBe('failed')
      expect(next.phase, JSON.stringify(next.error)).not.toBe('awaiting-consent')
      break
    }
    S.approved = true
  })

  scenario(
    'privileged-step',
    4 * HOUR,
    () => (S.path === 'adopt' ? 'adopt path: no privileged step' : needsApproval()),
    async () => {
      const api = core().api
      const waiting = await poll(
        api,
        S.operationId as string,
        (o) =>
          (o.phase === 'preparing-host' && o.pending_host_step !== null) ||
          ['failed', 'relogin-required', 'preparing-environment'].includes(o.phase),
        15 * MIN
      )
      expect(waiting.phase, JSON.stringify(waiting.error)).toBe('preparing-host')
      const step = waiting.pending_host_step as PendingHostStep
      report.detail('privileged-step', 'pending_host_step', step)
      expect(step.action).toBe(RECIPE_ID)
      expect(step.parameters).toMatchObject({
        user: S.facts.user,
        arch: S.facts.arch,
        family: S.facts.family,
        distro_id: S.facts.os.id,
      })
      expect(step.parameters.components.includes('docker-restart')).toBe(
        change('restart-docker') !== undefined
      )

      // The request file exactly as a client writes it: a 0700 folder of the user's, the file 0600.
      const request = {
        schema_version: 1,
        step_id: step.step_id,
        operation_id: S.operationId,
        action: step.action,
        recipe_id: step.recipe_id,
        recipe_digest: step.recipe_digest,
        parameters_digest: step.parameters_digest,
        nonce: step.nonce,
        expected_operation_revision: step.expected_operation_revision,
        data_folder: S.dataFolder,
        requested_at: Date.now(),
        parameters: step.parameters,
      }
      S.requestFile = join(S.hostSteps, `${step.step_id}.request.json`)
      writeFileSync(S.requestFile, `${JSON.stringify(request, null, 2)}\n`, { mode: 0o600 })
      chmodSync(S.requestFile, 0o600)
      const pidBefore = dockerPid()
      const { exit, result, stderr } = await execHostStep(S.requestFile)
      report.detail('privileged-step', 'result', result)
      for (const s of result?.steps ?? []) report.log(`  step ${s.id}: ${s.status} — ${s.detail}`)
      expect(result, `no result file; exit ${exit}; ${stderr}`).not.toBeNull()
      expect(result?.outcome, result?.log_tail).toBe('completed')
      expect(exit).toBe(0)
      S.stepEvidence = {
        pidBefore,
        pidAfter: dockerPid(),
        sentinelsRunning: S.sentinels.map(containerRunning),
        configure: result?.steps.find((s) => /runtime/.test(s.id))?.detail ?? '',
      }

      const receipt = await api.post(`/environments/operations/${S.operationId}/host-step-result`, {
        step_id: step.step_id,
        nonce: step.nonce,
        expected_operation_revision: step.expected_operation_revision,
        recipe_digest: step.recipe_digest,
        parameters_digest: step.parameters_digest,
        outcome: 'completed',
        receipt_id: `live-${randomUUID()}`,
      })
      expect(receipt.status, receipt.text).toBe(200)
      // The core re-probes after the receipt and moves on only by what it finds (spec).
      S.afterStep = await poll(
        api,
        S.operationId as string,
        (o) => !['checking', 'preparing-host'].includes(o.phase),
        15 * MIN
      )
      report.log(`after the receipt: ${S.afterStep.phase} ${S.afterStep.error?.code ?? ''}`)
      expect(S.afterStep.phase, JSON.stringify(S.afterStep.error)).not.toBe('failed')
    }
  )

  scenario(
    'restart-with-consent',
    10 * MIN,
    () =>
      restartApplies()
        ? S.stepEvidence === null
          ? 'the privileged step did not run'
          : null
        : 'Docker was not running without a GPU runtime before the test',
    async () => {
      const restart = change('restart-docker')
      report.detail('restart-with-consent', 'plan_change', restart)
      report.detail('restart-with-consent', 'step_evidence', S.stepEvidence)
      expect(restart).toBeDefined()
      // With access to the daemon the plan names the exact count it will stop; without, it says so.
      expect(restart?.params?.['running_containers']).toBe(
        S.facts.docker.user_reaches_daemon
          ? String((S.facts.docker.running_containers ?? 0) + S.sentinels.length)
          : 'unknown'
      )
      // Nothing restarted while waiting for consent; after the approved step Docker did restart.
      expect(S.consentEvidence?.['docker_pid_while_waiting']).toBe(S.dockerPidAtProbe)
      expect(S.stepEvidence?.pidBefore).toBe(S.dockerPidAtProbe)
      expect(S.stepEvidence?.pidAfter).not.toBe(S.stepEvidence?.pidBefore)
      expect(S.stepEvidence?.configure).toMatch(/restarted Docker/)
      expect(S.stepEvidence?.sentinelsRunning.some(Boolean)).toBe(false)
    }
  )

  scenario(
    'relogin',
    45 * MIN,
    () =>
      S.afterStep === null
        ? 'the privileged step did not complete (see privileged-step)'
        : S.afterStep.phase === 'relogin-required' || reloginExpected()
          ? null
          : `${S.facts.user} already had Docker access in this session; the operation went on to ${S.afterStep.phase}`,
    async () => {
      const operationId = S.operationId as string
      const waiting = S.afterStep as OperationView
      // The group was added for a user whose session did not carry it: skipping the relogin here
      // would be the core's bug, not a reason to skip the scenario.
      expect(
        waiting.phase,
        `${S.facts.user} was not in docker before the step, yet the operation went on to ${waiting.phase}`
      ).toBe('relogin-required')
      expect(waiting.error?.code).toBe('MANAGED_RELOGIN_REQUIRED')
      // The old session really cannot reach the daemon, and the group really exists for a new one.
      const dockerGid = Number(run('getent', ['group', 'docker']).stdout.split(':')[2])
      const oldSession = run(dockerCli() as string, [
        '-H',
        'unix:///var/run/docker.sock',
        'info',
        '--format',
        '{{.ServerVersion}}',
      ])
      // An old CLI exits 0 on "permission denied" and prints no server version; a new one exits 1.
      const oldSessionReached = oldSession.code === 0 && oldSession.stdout.trim() !== ''
      const members = run('getent', ['group', 'docker']).stdout.trim().split(':')[3]?.split(',') ?? []
      report.detail('relogin', 'old_session', {
        test_process_groups: process.getgroups?.() ?? [],
        docker_gid: dockerGid,
        docker_info_exit: oldSession.code,
        docker_info_reached: oldSessionReached,
        docker_group_members: members,
      })
      expect(process.getgroups?.() ?? []).not.toContain(dockerGid)
      expect(oldSessionReached, 'the test session already reaches Docker; nothing to relogin for').toBe(false)
      expect(members).toContain(S.facts.user)

      // An explicit resume re-checks the daemon and, still without access, waits again.
      const resumed = await core().api.post(`/environments/operations/${operationId}/resume`, {
        expected_revision: waiting.revision,
      })
      expect(resumed.status, resumed.text).toBe(200)
      const rechecked = await poll(
        core().api,
        operationId,
        (o) => o.revision > waiting.revision && !['checking'].includes(o.phase),
        5 * MIN
      )
      expect(rechecked.phase).toBe('relogin-required')

      // "Log out and back in": this core stops; the next one starts with the fresh login's groups.
      await stopCore()
      const fresh = await startCore('relogin', S.facts.user)
      const groups = processGroups(fresh.ready.pid)
      report.detail('relogin', 'fresh_core_groups', groups)
      expect(
        groups,
        'sudo -u did not give the new core the docker group; is `preserve_groups` set in sudoers?'
      ).toContain(dockerGid)
      // No resume from the test: the core continues at startup by itself (spec, D4).
      const continued = await poll(
        fresh.api,
        operationId,
        (o) => !['checking', 'relogin-required'].includes(o.phase),
        15 * MIN
      )
      report.detail('relogin', 'continued_to', continued.phase)
      expect(['preparing-environment', 'pulling-image', 'verifying', 'activating', 'ready']).toContain(
        continued.phase
      )
    }
  )

  scenario('gpu-pull-ready', 5 * HOUR, needsHostPrepared, async () => {
    const done = await poll(
      core().api,
      S.operationId as string,
      (o) => ['ready', 'failed', 'cancelled'].includes(o.phase),
      5 * HOUR
    )
    expect(done.phase, JSON.stringify(done.error)).toBe('ready')
    expect(done.plan_digest).toBe(done.approved_plan_digest)
    const phases = report.phaseNames()
    report.detail('gpu-pull-ready', 'phases', phases)
    report.detail('gpu-pull-ready', 'pulled_bytes', S.pullBytes)
    // The GPU check before the pull, then pull → verify → activate, in that order.
    const order = ['preparing-environment', 'pulling-image', 'verifying', 'activating', 'ready']
    const positions = order.map((phase) => phases.lastIndexOf(phase))
    expect(
      positions.every((p) => p >= 0),
      `phases seen: ${phases.join(' → ')}`
    ).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
    if (!S.engineImagePresentBefore) expect(S.pullBytes).toBeGreaterThan(0)
    expect(sudoDocker(['image', 'inspect', engineRef()]).code, `${engineRef()} is not in Docker`).toBe(0)

    const snapshot = await core().api.get<{
      environments: Array<{
        availability: string
        selinux: boolean | null
        gpus: Array<{ gpu_id: string }>
        installations: Array<{ status: string; active_descriptor_id: string | null }>
      }>
    }>('/snapshot')
    const environment = snapshot.body.environments[0]
    report.detail('gpu-pull-ready', 'environment', environment)
    expect(environment?.availability).toBe('supported')
    expect(environment?.installations).toContainEqual(
      expect.objectContaining({ status: 'ready', active_descriptor_id: S.descriptor.descriptor_id })
    )
    expect(environment?.gpus.map((g) => g.gpu_id).sort()).toEqual(S.facts.gpus.map((g) => g.uuid).sort())
    S.ready = true
  })

  scenario(
    'adopt-ready-host',
    5 * MIN,
    () => (S.path !== 'adopt' ? `setup path is ${S.path}` : needsReady()),
    async () => {
      const phases = report.phaseNames()
      expect(phases).not.toContain('preparing-host')
      expect(phases).not.toContain('relogin-required')
      expect(S.plan).toMatchObject({
        adopts_existing_engine: true,
        requires_elevation: false,
        system_changes: [],
      })
    }
  )

  scenario(
    'arch-adopt',
    5 * MIN,
    () =>
      S.facts.family !== 'pacman'
        ? `not Arch (${S.facts.os.id})`
        : S.path !== 'adopt'
          ? 'Arch without Docker and the toolkit ready (see arch-blocked)'
          : needsReady(),
    async () => {
      expect(S.plan).toMatchObject({
        adopts_existing_engine: true,
        requires_elevation: false,
        system_changes: [],
      })
      expect(report.phaseNames()).not.toContain('preparing-host')
    }
  )

  scenario('post-ready-probe-noop', 5 * MIN, needsReady, async () => {
    const plan = await probe()
    report.detail('post-ready-probe-noop', 'plan', plan)
    expect(plan).toMatchObject({
      availability: 'supported',
      adopts_existing_engine: true,
      requires_elevation: false,
      system_changes: [],
      blockers: [],
    })
  })

  scenario(
    'recipe-rerun-noop',
    30 * MIN,
    () =>
      S.requestFile === null
        ? 'no privileged step ran in this run (adopt path)'
        : S.afterStep === null
          ? 'the privileged step did not complete (see privileged-step)'
          : null,
    async () => {
      const folder = privateDir(join(S.hostSteps, 'rerun'))
      const again = join(folder, S.requestFile?.split('/').pop() as string)
      writeFileSync(again, readFileSync(S.requestFile as string), { mode: 0o600 })
      chmodSync(again, 0o600)
      const before = {
        pid: dockerPid(),
        packages: packageSetDigest(S.facts.family),
        daemon: daemonJsonDigest(),
      }
      const { exit, result } = await execHostStep(again)
      const after = {
        pid: dockerPid(),
        packages: packageSetDigest(S.facts.family),
        daemon: daemonJsonDigest(),
      }
      report.detail('recipe-rerun-noop', 'result', result)
      report.detail('recipe-rerun-noop', 'before_after', { before, after })
      expect(exit).toBe(0)
      expect(result?.outcome).toBe('completed')
      expect(
        result?.steps.filter((s) => s.status !== 'satisfied'),
        result?.log_tail
      ).toEqual([])
      expect(after).toEqual(before)
    }
  )

  scenario('model-chat', 4 * HOUR, needsReady, async () => {
    const api = core().api
    // The card a launch picks: the most memory (unified memory counts as the host's).
    const gpu = [...S.facts.gpus].sort((a, b) => cardBytes(b) - cardBytes(a))[0]
    expect(gpu).toBeDefined()
    const curated = pickCuratedModel(
      S.descriptor.curated_models,
      {
        total_bytes: cardBytes(gpu as NonNullable<typeof gpu>),
        compute_capability: gpu?.compute_capability ?? '0',
      },
      process.env['ATOMIC_LIVE_TRT_MODEL']
    )
    // A non-curated ATOMIC_LIVE_TRT_MODEL throws with its own message inside pickCuratedModel.
    expect(
      curated,
      `no curated model fits ${gpu?.name} (${cardBytes(gpu as NonNullable<typeof gpu>)} bytes, cc ${gpu?.compute_capability})`
    ).not.toBeNull()
    const model = curated as CuratedModel
    report.log(`model: ${model.repository}@${model.revision} (${model.note})`)
    // The documented flow: the exact revision's listing must be the one the descriptor pinned, and
    // the core's check route (when this build has it) must say it runs on this card.
    const prepared = await prepareCuratedModel({
      api,
      model,
      gpuId: gpu?.uuid,
      dataFolder: S.dataFolder,
      cacheRoot:
        process.env['ATOMIC_LIVE_MODEL_CACHE'] ?? join(homedir(), '.cache', 'atomic-chat-live', 'hf'),
      log: (line) => report.log(line),
    })
    report.detail('model-chat', 'check', prepared.check ?? 'route not in this build')
    const { id, quantization, files } = prepared
    const downloadMs = prepared.download_ms
    report.log(`model installed at ${prepared.dir}`)

    // A small card can be refused by the pre-launch memory check (weights plus the KV reserve for
    // the context length); ATOMIC_LIVE_TRT_CONTEXT_LENGTH shrinks that reserve for this load only.
    const overrides =
      CONTEXT_LENGTH === null
        ? {}
        : {
            context_length: CONTEXT_LENGTH,
            max_output_tokens: Math.min(4096, Math.floor(CONTEXT_LENGTH / 2)),
          }
    S.modelLoadStartedAt = Date.now()
    const loadStarted = S.modelLoadStartedAt
    const load = await api.post<{ session: { execution?: string; port: number } }>(
      `/models/tensorrt-llm/${id}/load`,
      Object.keys(overrides).length === 0 ? {} : { overrides },
      HOUR
    )
    const loadMs = Date.now() - loadStarted
    report.log(`load answered ${load.status} after ${(loadMs / 1000).toFixed(1)} s`)
    expect(load.status, load.text).toBe(200)
    S.modelId = id
    expect(load.body.session.execution).toBe('container')
    S.containerId =
      sudoDocker(['ps', '--filter', 'label=atomic.engine_id=tensorrt-llm', '--format', '{{.ID}}'])
        .stdout.trim()
        .split('\n')[0] || null

    const server = await api.post<{ port: number }>('/server/start', { port: PUBLIC_PORT })
    expect(server.status, server.text).toBe(200)
    const chat = await streamChat({
      url: `http://127.0.0.1:${server.body.port}/v1/chat/completions`,
      body: {
        model: id,
        stream: true,
        max_tokens: 128,
        messages: [{ role: 'user', content: 'What is 2 + 2? Answer in one short sentence. /no_think' }],
      },
      timeoutMs: 10 * MIN,
    })
    const { content: answer, reasoning, first_token_ms: firstTokenMs } = chat
    const result = {
      repository: model.repository,
      revision: model.revision,
      id,
      quantization,
      overrides,
      bytes: files.reduce((sum, f) => sum + f.size, 0),
      download_ms: downloadMs,
      load_ms: loadMs,
      chat_status: chat.status,
      first_token_ms: firstTokenMs,
      chat_ms: chat.total_ms,
      answer,
      reasoning,
      container_id: S.containerId,
      gpu: gpu?.uuid,
    }
    report.section('model', result)
    report.log(`chat ${chat.status}: first token after ${firstTokenMs} ms, answer ${JSON.stringify(answer)}`)
    expect(chat.status, chat.text.slice(0, 2000)).toBe(200)
    expect(String(chat.headers['content-type'])).toContain('text/event-stream')
    expect(chat.text).toContain('data: [DONE]')
    expect(`${answer}${reasoning}`.trim().length).toBeGreaterThan(0)
  })

  scenario(
    'selinux-no-permission-denied',
    10 * MIN,
    () =>
      S.facts.selinux !== 'enforcing'
        ? `SELinux is ${S.facts.selinux ?? 'not installed'} here (Fedora runs it enforcing)`
        : S.containerId === null
          ? 'no model container is running (see model-chat)'
          : null,
    async () => {
      const id = S.containerId as string
      // What the core must report is the *daemon's* SELinux, not the host's: Docker CE's dockerd runs
      // without --selinux-enabled by default (state A), Fedora's moby-engine with it (state C). Only a
      // daemon that labels containers needs the `:z` on our mounts (design D15).
      const options = sudoDocker(['info', '--format', '{{json .SecurityOptions}}'])
      expect(options.code, options.stderr).toBe(0)
      const securityOptions = JSON.parse(options.stdout.trim() || '[]') as string[]
      const daemonSelinux = securityOptions.some((o) => /(^|,)name=selinux(,|$)/.test(o))
      const snapshot = await core().api.get<{ environments: Array<{ selinux: boolean | null }> }>('/snapshot')
      const mounts = JSON.parse(
        sudoDocker(['inspect', '--format', '{{json .Mounts}}', id]).stdout || '[]'
      ) as Array<{
        Type: string
        Source: string
        Destination: string
        Mode: string
      }>
      const binds = mounts.filter((m) => m.Type === 'bind')
      // "Permission denied" only where it concerns our mounts: the engine image may print it about
      // unrelated things (MPI, UCX probing /sys) that no label change would fix.
      const containerLogs = sudoDocker(['logs', id], 5 * MIN)
      const coreLogs = await core().api.get<{ log_tail?: string }>(`/models/tensorrt-llm/${S.modelId}/logs`)
      const logLines =
        `${containerLogs.stdout}\n${containerLogs.stderr}\n${coreLogs.body?.log_tail ?? ''}`.split('\n')
      const paths = binds.flatMap((m) => [m.Source, m.Destination]).filter((p) => p !== '' && p !== '/')
      const deniedOnOurMounts = logLines.filter(
        (line) => /permission denied/i.test(line) && paths.some((p) => line.includes(p))
      )
      const deniedAnywhere = logLines.filter((line) => /permission denied/i.test(line))
      // AVC denials of container processes since the model load began: the kernel's own record.
      const since = Math.floor(S.modelLoadStartedAt / 1000)
      const audit = run('sudo', ['-n', 'ausearch', '-m', 'AVC', '-ts', 'today'])
      const avc = audit.stdout
        .split('\n')
        .filter((line) => /denied/.test(line) && /container_t/.test(line))
        .filter((line) => Number(/audit\((\d+)\./.exec(line)?.[1] ?? 0) >= since)
      report.detail('selinux-no-permission-denied', 'daemon_security_options', securityOptions)
      report.detail('selinux-no-permission-denied', 'mounts', mounts)
      report.detail(
        'selinux-no-permission-denied',
        'permission_denied_lines_anywhere',
        deniedAnywhere.slice(0, 20)
      )
      report.detail('selinux-no-permission-denied', 'avc_container_denials_since_load', avc.slice(0, 20))
      report.log(
        `selinux: daemon ${daemonSelinux ? 'labels containers' : 'does not label containers'}; ` +
          `${avc.length} AVC denial(s) for container_t since the load`
      )

      expect(snapshot.body.environments[0]?.selinux).toBe(daemonSelinux)
      if (daemonSelinux)
        for (const mount of binds) expect(mount.Mode, `${mount.Source} is mounted without :z`).toMatch(/z/)
      expect(deniedOnOurMounts, 'Permission denied on a mounted path').toEqual([])
      // ausearch answers 1 with "<no matches>" when there is nothing; anything else is recorded above.
      expect(avc, 'SELinux denied a container access since the model load').toEqual([])
    }
  )
})
