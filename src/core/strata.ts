import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomBytes } from 'node:crypto'
import { lstat, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { delimiter, dirname, isAbsolute, join, relative } from 'node:path'
import { modelDirFromId } from '../config/index.js'
import type { DataLayout } from '../config/index.js'
import { parseStrataDescriptor } from '../client/index.js'
import { defaultAvailableSpace } from '../downloads/index.js'
import { AtomicCoreError } from '../contracts/index.js'
import {
  compareBuilds,
  readStrataBuilds,
  strataBuildKey,
  verifyStrataBundle,
} from '../engine-builds/index.js'
import type { Build, EngineBuildsService } from '../engine-builds/index.js'
import { processStartId, verifyProcessIdentity } from '../lock/index.js'
import { StrataRegistry } from '../models/index.js'
import { parseStrataSettings } from '../settings/index.js'
import type { EmitFn, GpuClaimHook } from '../runtime/shared/index.js'
import { randomFreePort } from '../runtime/shared/index.js'
import {
  selectStrataDevice,
  strataHipOrdinal,
  StrataControlProcess,
  StrataProcessInspector,
  StrataOwnedControl,
  StrataPreparedCache,
  StrataProcessJournal,
  StrataRuntime,
  strataHttp,
  strataLaunchConfig,
  stageStrataWindowsPack,
  estimateStrata,
  planStrataMemory,
  strataResourceRefusal,
  StrataOperationStore,
  StrataPreparationService,
  StrataMaintenanceService,
  StrataPreparer,
  runStrataPreparationStep,
} from '../runtime/strata/index.js'
import type { StrataHostFacts, StrataLaunchIntent } from '../runtime/strata/index.js'
import type { StrataBackend, StrataCheckResult, StrataModelDescriptor } from '../contracts/index.js'
import type { StrataModelEntry } from '../models/index.js'
import { CORE_VERSION } from '../version.js'
import type { CoreLogger } from './types.js'

interface Options {
  layout: DataLayout
  instanceId: string
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  builds: () => Pick<EngineBuildsService, 'activeBuild'>
  facts: () => Promise<StrataHostFacts>
  availableSpace?: typeof defaultAvailableSpace
  settings: () => Record<string, unknown>
  trustedHosts: string[]
  claimGpu: GpuClaimHook
  emit: EmitFn
  log?: CoreLogger
}

const insufficientStrataVram = (requiredBytes: number) =>
  `This Strata profile needs at least ${Math.ceil(requiredBytes / 2 ** 20)} MiB of GPU memory. Use Auto context or select a GPU with more memory.`

async function libraryDirs(exe: string): Promise<string[]> {
  const root = await realpath(dirname(exe))
  const manifest = await readFile(join(root, 'BUILD.json'), 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '{}'
    throw error
  })
  const names: unknown = JSON.parse(manifest).lib_dirs
  const dirs = [root]
  if (!Array.isArray(names)) return dirs
  for (const name of names) {
    if (typeof name !== 'string' || isAbsolute(name) || name.split(/[\\/]/).includes('..')) continue
    const dir = join(root, name)
    if (
      (await lstat(dir).then(
        (s) => s.isDirectory(),
        () => false
      )) &&
      relative(root, await realpath(dir)) === relative(root, dir)
    )
      dirs.push(dir)
  }
  return [...new Set(dirs)]
}

/** Keep startup reconciliation and the session launcher on the same private scope and journal. */
export async function wireStrata(options: Options) {
  const { layout, platform, instanceId } = options
  const root = join(await realpath(layout.core.dir), 'strata')
  const journal = await StrataProcessJournal.open(root, 'strata-v1')
  const paths = layout.provider('strata')
  const registry = new StrataRegistry(layout)
  const store = await StrataOperationStore.open(root)
  const preparedRoot = join(paths.root, 'prepared')
  const cache = () => StrataPreparedCache.open(preparedRoot)
  const converters = await StrataProcessJournal.open(join(root, 'converters'), 'strata-converters-v1')
  const coreIdentity = async () => {
    const startId = await processStartId(process.pid)
    if (!startId) throw new AtomicCoreError('IO_ERROR', 'Cannot establish the core owner identity.')
    return { instanceId, pid: process.pid, startId }
  }
  const runtimePack = (profile: string) => join(root, 'control', profile + '.pack')
  const removeRuntimePack = (profile: string) =>
    rm(runtimePack(profile), { recursive: true, force: true }).catch(() => {})
  const controlOptions = (intent: StrataLaunchIntent, build: Build) => ({
    platform,
    bundleDir: build.dir,
    python: join(build.dir, build.strata!.variant.bundle.python),
    scopeDir: join(root, 'control'),
    profile: intent.profile,
    ownerPid: intent.core.pid,
    env: options.env,
  })
  const owner = async (intent: StrataLaunchIntent, build: Build) => {
    const control = await StrataControlProcess.open(controlOptions(intent, build))
    const inspector = new StrataProcessInspector(controlOptions(intent, build))
    return { control, owned: new StrataOwnedControl(intent, journal, control, inspector) }
  }
  const reconcileRetained = async (modelId?: string) => {
    const retained = journal
      .list()
      .filter(
        (entry) =>
          entry.core.instanceId !== instanceId && (modelId === undefined || entry.modelId === modelId)
      )
    if (!retained.length) return
    const builds = await readStrataBuilds(paths.backendsDir, CORE_VERSION)
    for (const entry of retained) {
      const build = builds.find((b) => b.dir === entry.build)
      if (!build?.strata) continue
      try {
        await verifyStrataBundle(build.dir, build.strata.release, build.strata.variant, true)
        const stopped = await (await owner(entry, build)).owned.reconcile(instanceId)
        if (stopped && platform === 'win32') await removeRuntimePack(entry.profile)
      } catch {
        // Keep unresolved claims visible even when the old build is damaged or unavailable.
      }
    }
  }
  await reconcileRetained()
  const canTarget = (
    backend: NonNullable<Build['strata']>['variant']['backend'],
    device: StrataHostFacts['devices'][number]
  ) => backend === 'metal' || (backend === 'hip' && platform === 'win32') || device.ordinal !== undefined
  const select = async (
    entry: StrataModelEntry,
    opts: { overrides?: Record<string, unknown>; timeoutSecs?: number } = {}
  ) => {
    const build = await options.builds().activeBuild('strata')
    if (!build?.strata)
      throw new AtomicCoreError(
        'BINARY_NOT_FOUND',
        'Install a compatible Strata build before loading a model.'
      )
    const descriptor = entry.strata.descriptor
    const { release, variant } = build.strata
    const minimum = strataBuildKey(descriptor.engine_release)
    if (!minimum || compareBuilds('strata', build, { ...build, tag: descriptor.engine_release }) < 0)
      throw new AtomicCoreError('MODEL_INCOMPATIBLE', 'This model requires a newer Strata release.')
    if (
      release.preparation_abi !== descriptor.preparation_abi ||
      !descriptor.compatible_variants.includes(variant.id)
    )
      throw new AtomicCoreError('MODEL_INCOMPATIBLE', 'The active Strata build cannot load this model.')
    const settings = parseStrataSettings({
      ...options.settings(),
      ...opts.overrides,
      ...(opts.timeoutSecs ? { timeout: opts.timeoutSecs } : {}),
    })
    const facts = await options.facts()
    const selection = selectStrataDevice(
      { ...release, variants: [variant] },
      { ...facts, devices: facts.devices.filter((device) => canTarget(variant.backend, device)) },
      descriptor.family,
      settings.gpu_id || undefined
    )
    if (!selection.device) throw new AtomicCoreError('MODEL_INCOMPATIBLE', selection.reason)
    const { device } = selection
    const backend: StrataBackend =
      variant.backend === 'cuda12' || variant.backend === 'cuda13' ? 'cuda' : variant.backend
    return { build, release, variant, settings, device, facts, backend }
  }
  const keyFor = (entry: StrataModelEntry, backend: StrataBackend) => ({
    modelId: entry.id,
    digest: entry.strata.source_digest,
    abi: entry.strata.descriptor.preparation_abi,
    backend,
  })
  const capabilities = (
    descriptor: StrataModelDescriptor,
    { release, variant }: NonNullable<Build['strata']>,
    settings: ReturnType<typeof parseStrataSettings>
  ) => {
    const suffix = platform === 'win32' ? '.exe' : ''
    const reader = (variant.backend === 'hip' ? 'strata-vision-hip' : 'strata-vision') + suffix
    const hasVision =
      descriptor.family === 'deepseek41' ||
      release.components.some(
        (c) => c.kind === 'qwen' && variant.components.includes(c.id) && c.executable_paths.includes(reader)
      )
    return {
      ...descriptor.capabilities,
      vision: descriptor.capabilities.vision && settings.vision === 'auto' && hasVision,
      structured_output:
        descriptor.capabilities.structured_output &&
        release.components.some(
          (c) => c.kind === 'control' && variant.components.includes(c.id) && c.structured_output === true
        ),
    }
  }
  const reconcileConverter = async (id: string) => {
    for (const row of converters.list().filter((entry) => entry.modelId === id)) {
      if (row.core.instanceId !== instanceId) {
        const verdict = await verifyProcessIdentity(row.core.pid, row.core.startId)
        if (verdict !== 'dead' && verdict !== 'mismatch')
          throw new AtomicCoreError('GPU_BUSY', 'The previous Strata preparation owner is still unverified.')
        // The converter cannot start work before its identity is durable and forbids descendants.
        if (!row.processes.length)
          await converters.observe(row.generation, { processes: [], launchComplete: true })
      }
      if (!(await converters.confirmStopped(row.generation)))
        throw new AtomicCoreError('GPU_BUSY', 'The previous Strata converter has not exited.')
    }
  }
  const preparations = new StrataPreparationService(store, {
    resolve: async (request) => {
      const entry = await registry.get(request.model_id)
      const { backend } = await select(entry)
      return { backend, digest: entry.strata.source_digest }
    },
    emit: (operation) => options.emit('strata:preparation-changed', operation),
    run: async (operation, backend, signal, report) => {
      const preparer = new StrataPreparer({
        registry,
        cache: await cache(),
        reconcile: reconcileConverter,
        context: async (entry, expected) => {
          const { build, release, variant, backend: selected } = await select(entry)
          if (selected !== expected)
            throw new AtomicCoreError('MODEL_INCOMPATIBLE', 'The Strata preparation backend changed.')
          await verifyStrataBundle(build.dir, release, variant, true)
          return {
            python: join(build.dir, variant.bundle.python),
            controlDir: join(build.dir, 'control'),
            platform,
            env: options.env,
          }
        },
        execute: async (context, step, abort) => {
          const generation = randomBytes(16).toString('hex')
          await converters.begin({
            generation,
            profile: 'atomic-' + generation,
            modelId: operation.model_id,
            cards: [],
            build: dirname(context.controlDir),
            core: await coreIdentity(),
          })
          try {
            await runStrataPreparationStep(context, step, abort, async (child) => {
              const startId = await processStartId(child.pid)
              if (!startId) throw new AtomicCoreError('IO_ERROR', 'Could not identify the Strata converter.')
              await converters.observe(generation, {
                processes: [{ pid: child.pid, role: 'converter', startId }],
                launchComplete: true,
              })
            })
          } finally {
            // The converter runner awaits its child on both success and failure.
            await converters.observe(generation, { processes: [], launchComplete: true })
            await converters.confirmStopped(generation)
          }
        },
      })
      await runtime.engineHost().exclusive(() => preparer.run(operation, backend, signal, report))
    },
  })
  const maintenance = new StrataMaintenanceService(preparations, {
    stop: async (id) => {
      const result = await runtime.unload(id)
      if (!result.success)
        throw new AtomicCoreError('GPU_BUSY', result.error ?? 'Strata shutdown is unconfirmed.')
      await reconcileConverter(id)
    },
    inspect: async (id) => {
      try {
        await lstat(modelDirFromId(registry.modelsDir, id))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
      const entry = await registry.get(id)
      try {
        const { backend } = await select(entry)
        const verified = await registry.verify(id)
        return {
          digest: entry.strata.source_digest,
          ready:
            verified.strata.source_digest === entry.strata.source_digest &&
            !!(await (await cache()).ready(keyFor(entry, backend))),
        }
      } catch {
        return { digest: entry.strata.source_digest, ready: false }
      }
    },
    cleanup: async (id, keep) => (await cache()).cleanup(id, keep),
  })
  const runtime: StrataRuntime = new StrataRuntime({
    claimGpu: options.claimGpu,
    emit: options.emit,
    ...(options.log ? { log: options.log } : {}),
    guardLoad: (id, work) => maintenance.withLoad(id, work),
    stopPreparations: () => preparations.shutdown(),
    retained: () => journal.list().filter((entry) => entry.core.instanceId !== instanceId),
    reconcileRetained,
    buildClaims: () => converters.list().flatMap((entry) => (entry.build ? [entry.build] : [])),
    prepare: async (modelId, generation, opts, signal) => {
      const entry = await registry.get(modelId)
      const descriptor = entry.strata.descriptor
      const selected = await select(entry, opts)
      const { build, release, variant, device, facts, backend } = selected
      const { settings, minimumVramBytes } = planStrataMemory(
        descriptor,
        backend,
        device.memoryBytes,
        selected.settings
      )
      if (minimumVramBytes !== undefined && device.memoryBytes < minimumVramBytes)
        throw new AtomicCoreError('MODEL_INCOMPATIBLE', insufficientStrataVram(minimumVramBytes))
      const prepared = await (await cache()).ready(keyFor(entry, backend))
      if (!prepared)
        throw new AtomicCoreError(
          'MODEL_INCOMPATIBLE',
          'Prepare the Strata model for this build before loading.'
        )
      await verifyStrataBundle(build.dir, release, variant, true)
      const verified = await registry.verify(modelId, signal)
      if (verified.strata.source_digest !== entry.strata.source_digest)
        throw new AtomicCoreError('MODEL_INCOMPATIBLE', 'Strata source changed during load.')
      signal.throwIfAborted()
      const intent = {
        generation,
        profile: 'atomic-' + generation,
        modelId,
        cards: [device.id],
        build: build.dir,
        core: await coreIdentity(),
      }
      const { control, owned } = await owner(intent, build)
      const state = join(root, 'control')
      const qwenDir = join(build.dir, 'components/qwen')
      let gpuOrdinal = device.ordinal
      if (variant.backend === 'hip' && platform === 'win32') {
        const probe = join(qwenDir, 'strata-device.exe')
        const SystemRoot = options.env.SystemRoot ?? options.env.SYSTEMROOT ?? 'C:\\Windows'
        const libs = await libraryDirs(probe)
        const result = await promisify(execFile)(probe, ['--list-devices'], {
          cwd: qwenDir,
          windowsHide: true,
          timeout: 30_000,
          maxBuffer: 128 * 1024,
          signal,
          env: { SystemRoot, PATH: [...libs, join(SystemRoot, 'System32')].join(delimiter) },
        }).catch(() => null)
        if (result) gpuOrdinal = strataHipOrdinal(device, facts.devices, result.stdout)
      }
      const caps = capabilities(descriptor, { release, variant }, settings)
      const port = await randomFreePort([])
      const key = randomBytes(32).toString('hex')
      const launch = {
        contextLimit: verified.contextLimit,
        bundle: build.dir,
        source: entry.dir,
        prepared,
        state,
        modelId,
        key,
        port,
        platform,
        backend: variant.backend,
        settings: { ...settings, vision: caps.vision ? 'auto' : 'off' },
        ramBytes: facts.ramBytes,
        ...(gpuOrdinal !== undefined ? { gpuOrdinal } : {}),
      }
      const configPath = join(state, intent.profile + '.run.json')
      const logPath = join(state, intent.profile + '.log')
      const configure = async (preparedDir: string) => {
        const config = strataLaunchConfig(descriptor, { ...launch, prepared: preparedDir })
        await writeFile(
          configPath,
          JSON.stringify({ ...config, log: logPath, lib_dirs: await libraryDirs(config.exe) }) + '\n',
          { flag: 'wx', mode: 0o600 }
        )
        await control.create(configPath)
      }
      const windowsDeepseek = platform === 'win32' && descriptor.family === 'deepseek41'
      if (!windowsDeepseek) await configure(prepared)
      let staged = false
      const launchOwner = windowsDeepseek
        ? {
            start: async (timeoutMs: number, startup?: AbortSignal) => {
              const directory = runtimePack(intent.profile)
              staged = await stageStrataWindowsPack(prepared, directory)
              startup?.throwIfAborted()
              await configure(staged ? directory : prepared)
              return owned.start(timeoutMs, startup)
            },
            status: () => owned.status(),
            stop: async () => {
              const stopped = await owned.stop()
              if (stopped && staged) await removeRuntimePack(intent.profile)
              return stopped
            },
          }
        : owned
      return {
        build: build.dir,
        owner: launchOwner,
        gpuId: device.id,
        timeoutMs: settings.timeout * 1000,
        modelPath: join(entry.dir, descriptor.inputs.weights[0]!),
        logPath,
        ...strataHttp(
          port,
          key,
          modelId,
          caps,
          settings.context_length || descriptor.context_length,
          options.trustedHosts
        ),
      }
    },
  })
  const check = async (raw: unknown): Promise<StrataCheckResult> => {
    const body = raw as Record<string, unknown> | null
    const keys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : []
    const modelId =
      keys.length === 1 && keys[0] === 'model_id' && typeof body?.model_id === 'string'
        ? body.model_id
        : undefined
    const hasDescriptor =
      keys.includes('descriptor') && keys.every((key) => key === 'descriptor' || key === 'staged_bytes')
    if (!body || (!modelId && !hasDescriptor))
      throw new AtomicCoreError('INVALID_ARGUMENT', 'Send a Strata descriptor or model_id.')
    let descriptor: StrataModelDescriptor
    let stagedBytes = 0
    const result: StrataCheckResult = {
      verdict: 'ok',
      reason: null,
      capabilities: null,
      requirements: null,
      preparation_status: null,
      estimates: null,
      compatible_devices: [],
      warnings: [],
      qualification: null,
    }
    const refuse = (verdict: StrataCheckResult['verdict'], reason: string): StrataCheckResult => ({
      ...result,
      verdict,
      reason,
    })
    let entry: StrataModelEntry | undefined
    if (modelId) {
      if (maintenance.list().some((o) => o.model_id === modelId && o.state !== 'completed'))
        return refuse('maintenance', 'Strata model is under maintenance.')
      try {
        entry = await registry.verify(modelId)
        descriptor = entry.strata.descriptor
      } catch (error) {
        return refuse('invalid-installation', (error as Error).message)
      }
    } else {
      try {
        descriptor = parseStrataDescriptor(body.descriptor)
      } catch (error) {
        throw new AtomicCoreError('INVALID_ARGUMENT', (error as Error).message)
      }
      if (keys.includes('staged_bytes')) {
        const count = body.staged_bytes
        if (
          typeof count !== 'number' ||
          !Number.isSafeInteger(count) ||
          count < 0 ||
          count > descriptor.requirements.download_bytes
        )
          throw new AtomicCoreError(
            'INVALID_ARGUMENT',
            'Strata staged_bytes must be an integer between zero and the total source size.'
          )
        stagedBytes = count
      }
    }
    result.capabilities = descriptor.capabilities
    result.requirements = descriptor.requirements
    result.qualification = descriptor.qualification
    const build = await options.builds().activeBuild('strata')
    if (!build?.strata) return refuse('engine-not-installed', 'A compatible Strata bundle is not installed.')
    const { release, variant } = build.strata
    if (compareBuilds('strata', build, { ...build, tag: descriptor.engine_release }) < 0)
      return refuse('requires-newer-engine', 'This model requires a newer Strata release.')
    if (
      !descriptor.compatible_variants.includes(variant.id) ||
      release.preparation_abi !== descriptor.preparation_abi
    )
      return refuse('platform-unsupported', 'This model is incompatible with the installed Strata variant.')
    const facts = await options.facts()
    const family = descriptor.family
    const backend: StrataBackend = variant.backend.startsWith('cuda')
      ? 'cuda'
      : (variant.backend as StrataBackend)
    const settings = parseStrataSettings(options.settings())
    result.capabilities = capabilities(descriptor, { release, variant }, settings)
    const selected = facts.devices.filter(
      (candidate) =>
        (!settings.gpu_id || candidate.id === settings.gpu_id) &&
        canTarget(variant.backend, candidate) &&
        !!selectStrataDevice({ ...release, variants: [variant] }, facts, family, candidate.id).device
    )
    if (!selected.length)
      return refuse(
        facts.devices.length ? 'platform-unsupported' : 'unknown-hardware',
        'No verified device supports this Strata variant.'
      )
    result.compatible_devices = selected.map(({ id }) => ({ gpu_id: id, backend, variant_id: variant.id }))
    const device = selected[0]!
    const memory = planStrataMemory(descriptor, backend, device.memoryBytes, settings)
    result.capabilities = capabilities(descriptor, { release, variant }, memory.settings)
    let ready: string | null = null
    let previousBytes = 0
    if (entry) {
      const existing = await StrataPreparedCache.find(preparedRoot)
      const key = keyFor(entry, backend)
      ready = (await existing?.ready(key)) ?? null
      previousBytes = descriptor.requirements.download_bytes
      try {
        previousBytes += (await existing?.publishedBytes(entry.id)) ?? 0
      } catch {
        result.warnings.push('The previous Strata derivative footprint could not be measured.')
      }
      const rows = store.snapshot().preparations
      const sameSource = rows.filter(
        ({ operation }) => operation.model_id === modelId && operation.source_digest === key.digest
      )
      const latest = sameSource.findLast((row) => row.backend === backend)?.operation
      if (ready) result.preparation_status = 'ready'
      else if (latest && ['queued', 'preparing', 'verifying'].includes(latest.state))
        result.preparation_status = 'preparing'
      else if (latest?.state === 'failed') result.preparation_status = 'failed'
      else result.preparation_status = sameSource.length ? 'preparation-required' : 'files-ready'
    }
    result.estimates = estimateStrata(descriptor, {
      backend,
      unified: device.unified,
      installed: !!entry,
      prepared: !!ready,
      previousBytes,
      stagedBytes,
      memoryMode: settings.memory_mode,
      minimumVramBytes: memory.minimumVramBytes,
    })
    result.warnings.push('Memory and disk figures are planning estimates for the pinned recipe.')
    if (settings.memory_mode === 'ssd') result.warnings.push('SSD streaming may reduce generation speed.')
    const disk = await (options.availableSpace ?? defaultAvailableSpace)(paths.root)
    if (disk === undefined) result.warnings.push('Available disk space could not be measured.')
    const capacity = strataResourceRefusal(result.estimates, {
      disk,
      ram: facts.ramBytes,
      gpu: device.memoryBytes,
    })
    const gib = (bytes: number) => (bytes / 2 ** 30).toFixed(2)
    if (capacity === 'insufficient-disk')
      return refuse(
        capacity,
        `Strata estimates ${gib(result.estimates.required_disk_bytes - previousBytes)} GiB of additional disk space for the sources and preparation. This drive has ${gib(disk!)} GiB free.`
      )
    if (memory.minimumVramBytes !== undefined && device.memoryBytes < memory.minimumVramBytes)
      return refuse('insufficient-memory', insufficientStrataVram(memory.minimumVramBytes))
    if (capacity === 'insufficient-memory' && !device.unified) {
      const { ram_bytes, vram_bytes } = result.estimates
      if (device.memoryBytes < vram_bytes)
        return refuse(
          capacity,
          `Strata estimates ${gib(vram_bytes)} GiB of VRAM for this model. The selected GPU reports ${gib(device.memoryBytes)} GiB.`
        )
      const message = `Strata estimates ${gib(ram_bytes)} GiB of system RAM for this model. This device reports ${gib(facts.ramBytes)} GiB.`
      if (descriptor.family !== 'qwen36' || backend !== 'cuda' || settings.memory_mode !== 'auto')
        return refuse(capacity, message)
      // Qwen3.6 preparation reads tokenizer metadata. Only the engine loads the expert arena.
      result.warnings.push(
        `${message} You can download and prepare the model, but it may run out of memory at launch.`
      )
      return result
    }
    if (capacity === 'insufficient-memory')
      return refuse(capacity, 'The estimated Strata working memory exceeds this host’s capacity.')
    return result
  }
  return {
    runtime,
    registry,
    preparations,
    maintenance,
    check,
    contextLimit: (id: string) => registry.contextLimit(id),
  }
}
