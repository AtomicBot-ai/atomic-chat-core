import { ownedFlmPath } from './owned-path.js'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, win32 } from 'node:path'
import {
  AtomicCoreError,
  type FastFlowLmAccelerators,
  type ModelYmlFastFlowLm,
  type SessionInfo,
} from '../../contracts/index.js'
import type { AsyncMutex } from '../../diffusion/index.js'
import { compareBuilds, type EngineHost } from '../../engine-builds/index.js'
import type { FastFlowLmRegistry } from '../../models/index.js'
import { verifyProcessIdentity, processStartId, type ProcessJournal } from '../../lock/index.js'
import {
  SidecarTable,
  spawnAndAwaitReady,
  randomFreePort,
  retryOnTakenPort,
  exitedOnTakenPort,
  raceLoadCancel,
  throwIfLoadCancelled,
  type LocalRuntime,
  type LocalLoadOptions,
  type EmitFn,
} from '../shared/index.js'
import { startManagedGateway, generateGatewayKey, type ManagedGateway } from '../managed-text/index.js'
import { FLM_ROUTES, flmChatRequest, flmResponse, loadedCheckpoint } from './policy.js'
import { GenerationQueue } from './generation-queue.js'

interface Options {
  registry: FastFlowLmRegistry
  cache: string
  dataRoot: string
  instanceId: string
  journal?: ProcessJournal
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  emit: EmitFn
  trustedHosts: string[]
  settings: () => Promise<Record<string, unknown>>
  resolveBuild: () => Promise<{ dir: string; tag: string } | undefined>
  probe: () => Promise<FastFlowLmAccelerators>
  assertLoadable: (id: string) => Promise<void>
  spawn?: typeof spawnAndAwaitReady
  lock: AsyncMutex
}
type Installed = Awaited<ReturnType<FastFlowLmRegistry['get']>>
interface Extra {
  metadata: ModelYmlFastFlowLm
  context: number
  gateway: ManagedGateway
}

export class FastFlowLmRuntime implements LocalRuntime {
  private readonly table: SidecarTable<Extra>
  constructor(private readonly options: Options) {
    this.table = new SidecarTable({
      provider: 'fastflowlm',
      engine: 'FastFlowLM',
      instanceId: options.instanceId,
      journal: options.journal,
      emit: options.emit,
      unloadGraceMs: 3000,
      shutdownGraceMs: 1000,
      describeExit: (exit, stderr) =>
        'FastFlowLM exited (' + (exit.code ?? exit.signal) + '). ' + stderr.slice(-1024),
    })
  }
  list() {
    return this.table.list()
  }
  findSession(id: string) {
    return this.table.findSession(id)
  }
  getLoadedModels() {
    return this.table.getLoadedModels()
  }
  isLoading(id: string) {
    return this.table.isLoading(id)
  }
  engineHost(): EngineHost {
    return {
      exclusive: (work) => this.options.lock.run(work),
      inUse: async () => this.table.runningExes().map((path) => dirname(path)),
      activate: async (dir, replaced) => {
        for (const id of this.table.getLoadedModels())
          if (replaced || dirname(this.table.get(id)!.exe) !== dir) await this.stop(id)
      },
    }
  }
  routePolicy(id: string) {
    const extra = this.table.get(id)?.extra
    if (!extra) return undefined
    return {
      routes: FLM_ROUTES,
      tools: extra.metadata.capabilities.tools,
      structuredOutput: extra.metadata.capabilities.structured_output,
      mapError: () => null,
      contextLength: extra.context,
    }
  }
  async load(id: string, opts: LocalLoadOptions = {}) {
    const turn = this.options.lock.acquire()
    const release = await raceLoadCancel(turn, opts.signal).catch((error) => {
      void turn.then((release) => release())
      throw error
    })
    try {
      this.table.assertRunning()
      throwIfLoadCancelled(opts.signal)
      if (opts.isEmbedding || opts.exePath)
        throw new AtomicCoreError('INVALID_ARGUMENT', 'FastFlowLM requires its managed chat executable.')
      await this.options.assertLoadable(id)
      return await this.table.load(id, () => this.start(id, opts), opts.signal)
    } finally {
      release()
    }
  }
  private async stop(id: string) {
    const result = await this.unload(id)
    if (!result.success)
      throw new AtomicCoreError(
        'FASTFLOWLM_DEVICE_BUSY',
        'Could not stop the previous FastFlowLM process.',
        result.error
      )
  }
  private async checkOrphans(id?: string) {
    for (const row of this.options.journal?.list() ?? []) {
      if (
        row.provider !== 'fastflowlm' ||
        row.instance_id === this.options.instanceId ||
        (id && row.model_id !== id)
      )
        continue
      const verdict = await verifyProcessIdentity(row.pid, row.process_start_id)
      if (verdict === 'dead' || verdict === 'mismatch') continue
      throw new AtomicCoreError(
        'FASTFLOWLM_DEVICE_BUSY',
        'Cannot confirm that the previous FastFlowLM process exited.',
        String(row.pid)
      )
    }
  }
  private async start(id: string, opts: LocalLoadOptions) {
    await this.checkOrphans()
    const model = await this.options.registry.forLoad(id)
    const build = await this.options.resolveBuild()
    if (!build || !isAbsolute(build.dir))
      throw new AtomicCoreError('FASTFLOWLM_ENGINE_NOT_INSTALLED', 'Install a managed FastFlowLM build.')
    const metadata = model.yml.fastflowlm
    if (
      [metadata.minimum_flm_version, 'flm-' + model.formatVersion + '-r1'].some(
        (tag) => compareBuilds('fastflowlm', build, { tag }) < 0
      )
    )
      throw new AtomicCoreError(
        'FASTFLOWLM_INVALID_INSTALLATION',
        'This installation requires a newer FastFlowLM engine.'
      )
    for (const other of this.getLoadedModels()) await this.stop(other)
    const facts = await this.options.probe()
    if (facts.blockers.includes('device-busy'))
      throw new AtomicCoreError('FASTFLOWLM_DEVICE_BUSY', 'Another process is using the selected NPU.')
    if (!facts.ready || facts.engine_version !== build.tag)
      throw new AtomicCoreError(
        'FASTFLOWLM_ENVIRONMENT_NOT_READY',
        'The selected engine cannot use the NPU.',
        facts.reason ?? 'engine changed'
      )
    throwIfLoadCancelled(opts.signal)
    const settings = { ...(await this.options.settings()), ...opts.overrides }
    const context = Math.min(
      metadata.context_length,
      Number(settings.ctx_len) > 0 ? Math.floor(Number(settings.ctx_len)) : metadata.context_length
    )
    const timeout = opts.timeoutSecs ?? (Number(settings.timeout) > 0 ? Number(settings.timeout) : 600)
    await ownedFlmPath(this.options.dataRoot, this.options.cache)
    await mkdir(this.options.cache, { recursive: true, mode: 0o700 })
    const cache = await mkdtemp(join(this.options.cache, 'session-'))
    try {
      await mkdir(join(cache, 'xclbins'))
      await symlink(
        model.dir,
        join(cache, 'xclbins', id),
        this.options.platform === 'win32' ? 'junction' : 'dir'
      )
      return await this.launch(model, build.dir, cache, context, timeout, opts)
    } catch (error) {
      await rm(cache, { recursive: true, force: true })
      throw error
    }
  }
  private async launch(
    model: Installed,
    build: string,
    cache: string,
    context: number,
    timeout: number,
    opts: LocalLoadOptions
  ): Promise<SessionInfo> {
    const { id } = model,
      metadata = model.yml.fastflowlm
    const windows = this.options.platform === 'win32'
    const systemRoot = this.options.env.SystemRoot ?? 'C:\\Windows'
    const hostEnv: Record<string, string> = windows
      ? {
          SystemRoot: systemRoot,
          PATH: win32.join(systemRoot, 'System32'),
          TEMP: cache,
          TMP: cache,
          LOCALAPPDATA: cache,
          USERPROFILE: cache,
        }
      : {
          PATH: '/usr/bin:/bin',
          HOME: cache,
          TMPDIR: cache,
          LD_LIBRARY_PATH: join(build, 'lib', 'x86_64-linux-gnu') + ':' + join(build, 'lib'),
          XILINX_XRT: build,
        }
    const env = { ...hostEnv, ...model.env, FLM_XCLBIN_PATH: cache }
    const exe = await ownedFlmPath(this.options.dataRoot, join(build, windows ? 'flm.exe' : 'flm-real'))
    const { started, url, port } = await retryOnTakenPort(
      async () => {
        const port = await randomFreePort(this.table.usedPorts()),
          url = 'http://127.0.0.1:' + port
        let startingPid: number | undefined
        let bound = false
        const started = await (this.options.spawn ?? spawnAndAwaitReady)(
          {
            exe,
            args: [
              'serve',
              metadata.checkpoint,
              '--atomic-local-only',
              '--host',
              '127.0.0.1',
              '--port',
              String(port),
              '--ctx-len',
              String(context),
              '--backend',
              'flm',
            ],
            cwd: cache,
            env,
            platform: this.options.platform,
          },
          {
            onSpawn: async (child) => {
              if (!this.options.journal) return
              startingPid = child.pid
              await this.options.journal.add({
                instance_id: this.options.instanceId,
                pid: child.pid,
                process_start_id: (await processStartId(child.pid)) ?? null,
                exe,
                provider: 'fastflowlm',
                model_id: id,
                port,
                started_at: new Date().toISOString(),
              })
            },
            timeoutMs: timeout * 1000,
            signal: this.table.signal,
            ...(opts.signal ? { cancelSignal: opts.signal } : {}),
            readyMarkers: [],
            outputTailChars: 16384,
            // A different process may have claimed the port since the free-port check.
            onLine: (stream, line) => {
              if (stream === 'stdout' && line.includes('WebServer started on port ' + port + ' with '))
                bound = true
            },
            healthCheck: async () => {
              if (!bound) return false
              const r = await fetch(url + '/v1/models', {
                signal: AbortSignal.timeout(1000),
                redirect: 'error',
              })
              return r.ok && loadedCheckpoint(await r.json(), metadata.checkpoint)
            },
            classifyExit: (_exit, stderr, stdout) => {
              const log = (stderr + '\n' + stdout).slice(-4096)
              return new AtomicCoreError(
                /device.*busy|npu.*in use|EBUSY/i.test(log)
                  ? 'FASTFLOWLM_DEVICE_BUSY'
                  : 'FASTFLOWLM_PROCESS_CRASH',
                'FastFlowLM exited during model load.',
                log
              )
            },
            timeoutError: (stderr) =>
              new AtomicCoreError(
                'FASTFLOWLM_TIMEOUT',
                'FastFlowLM did not report the loaded checkpoint in time.',
                stderr.slice(-1024)
              ),
          }
        ).catch(async (error) => {
          if (startingPid) await this.options.journal?.remove(startingPid)
          throw error
        })
        return { started, url, port }
      },
      (e) => e instanceof AtomicCoreError && exitedOnTakenPort(e.details),
      () => {}
    )
    const process = started.process,
      apiKey = generateGatewayKey()
    const queue = new GenerationQueue(4, async () => {
      // This invalid chat takes the same native generation lock and returns before inference.
      // Receiving its precise local-only rejection proves the previous handler released that lock.
      try {
        const response = await fetch(url + '/v1/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
          redirect: 'error',
          signal: AbortSignal.timeout(3000),
        })
        if (
          response.status === 400 &&
          ((await response.json()) as { error?: unknown }).error === 'invalid_local_request'
        )
          return
      } catch {
        /* The native worker failed to acknowledge cancellation. */
      }
      await process.terminate(0)
    })
    let gateway: ManagedGateway
    try {
      gateway = await startManagedGateway({
        upstream: { host: '127.0.0.1', port },
        apiKey,
        allowedHosts: this.options.trustedHosts,
        routes: FLM_ROUTES,
        rewritableRoutes: [FLM_ROUTES[1]],
        rewriteRequestBody: (_route, body) =>
          flmChatRequest(body, id, metadata.checkpoint, metadata.capabilities),
        rewriteResponseFor: () => (json) => flmResponse(json, id),
        rewriteModelsResponse: (json) => flmResponse(json, id),
        scheduleChat: (signal, forward) => queue.run(signal, forward),
      })
    } catch (e) {
      await process.terminate(0)
      await this.options.journal?.remove(process.pid)
      throw e
    }
    void process.exited
      .then(async () => {
        await gateway.close()
        await rm(cache, { recursive: true, force: true })
      })
      .catch(() => {})
    return this.table
      .adopt(
        {
          info: {
            pid: process.pid,
            port: gateway.port,
            model_id: id,
            model_path: model.dir,
            is_embedding: false,
            api_key: apiKey,
          },
          process,
          exe,
          extra: { metadata, context, gateway },
        },
        opts.signal
      )
      .catch(async (error) => {
        await this.options.journal?.remove(process.pid)
        throw error
      })
  }
  async unload(id: string) {
    await this.checkOrphans(id)
    return this.table.unload(id)
  }
  async autoIncreaseCtx(id: string) {
    return {
      ok: false as const,
      reason: this.findSession(id) ? ('unsupported' as const) : ('not-loaded' as const),
    }
  }
  async recreateSession(id: string) {
    if (!this.findSession(id)) return { ok: false as const, reason: 'not-loaded' as const }
    await this.stop(id)
    return { ok: true as const, session: await this.load(id) }
  }
  shutdown() {
    return this.table.shutdown()
  }
}
