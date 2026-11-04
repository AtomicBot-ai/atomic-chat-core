/**
 * LiteRT-LM's one accelerator, `openvino` (openspec change `add-litert-lm-runtime`, task 6.4, design
 * D3): the Intel libraries an NPU variant needs on Windows, from the `openvino` wheel the active
 * release pins in conf's manifest. Offered only on a machine whose Intel NPU generation LiteRT-LM has
 * files for; prepared only when a client orders it — one prepare at a time, each step published as
 * `litert-lm:accelerators`.
 *
 * A prepare downloads the wheel with its sha256 and size checked, keeps only `openvino/libs/**` and
 * puts it at `<data>/litert-lm/accelerators/openvino/<version>/`, marked last: a folder without the
 * marker is not prepared. A second prepare of the same version downloads nothing.
 */

import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AtomicCoreError } from '../../contracts/index.js'
import type {
  CoreEvents,
  LiteRtLmAccelerators,
  LiteRtLmNpu,
  LiteRtLmPrepareRequest,
  LiteRtLmPrepareResult,
  ProxyConfig,
} from '../../contracts/index.js'
import { OWNER_MARKER } from '../../diffusion/install.js'
import { extractArchive } from '../../downloads/index.js'
import type {
  LiteRtLmAccelerator as ManifestAccelerator,
  LiteRtLmRelease,
} from '../../engine-builds/manifest.js'

export const OPENVINO = 'openvino'

export interface LiteRtLmAcceleratorDeps {
  /** `<data>/litert-lm/accelerators`. */
  acceleratorsDir: string
  /** `<data>/litert-lm/tmp`: the download and the unpacked wheel, gone after. */
  tmpDir: string
  resolveBuild: () => Promise<{ dir: string; version: string } | undefined>
  /** The manifest's release of a LiteRT-LM version (a cached manifest is fine); `null` when unknown. */
  release: (version: string) => Promise<LiteRtLmRelease | null>
  /** This machine's Intel NPU generation LiteRT-LM files target, or `null`. */
  npuGeneration: () => Promise<LiteRtLmNpu | null>
  /** Download one file with its sha256 and size checked; `onFraction` 0…1 as it goes. */
  download: (
    taskId: string,
    item: { url: string; save_path: string; sha256: string; size: number; proxy?: ProxyConfig | null },
    onFraction: (fraction: number) => void
  ) => Promise<void>
  emit: (name: 'litert-lm:accelerators', payload: CoreEvents['litert-lm:accelerators']) => void
  now?: () => number
}

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false
  )

export class LiteRtLmAcceleratorService {
  private preparing = false
  /** The reason the last failed prepare of each version gave. */
  private readonly failures = new Map<string, string>()
  private readonly now: () => number

  constructor(private readonly deps: LiteRtLmAcceleratorDeps) {
    this.now = deps.now ?? Date.now
  }

  private dirOf(version: string): string {
    return join(this.deps.acceleratorsDir, OPENVINO, version)
  }

  /** What this machine is offered: OpenVINO of the active release, on an Intel NPU it targets. */
  private async offered(): Promise<{
    answer: LiteRtLmAccelerators
    accelerator: ManifestAccelerator | null
  }> {
    const build = await this.deps.resolveBuild()
    if (!build)
      return {
        answer: { installed: false, build: null, npu: null, accelerators: [], error: null },
        accelerator: null,
      }
    const name = `${build.version}/${build.dir.split(/[\\/]/).at(-1) ?? ''}`
    const npu = await this.deps.npuGeneration()
    if (!npu)
      return {
        answer: { installed: true, build: name, npu: null, accelerators: [], error: null },
        accelerator: null,
      }
    const release = await this.deps.release(build.version)
    const accelerator = release?.accelerators.find((candidate) => candidate.id === OPENVINO) ?? null
    if (!accelerator)
      return {
        answer: {
          installed: true,
          build: name,
          npu,
          accelerators: [],
          error: release
            ? `LiteRT-LM ${build.version} pins no OpenVINO.`
            : `The LiteRT-LM manifest has no release ${build.version}; it lists the accelerator.`,
        },
        accelerator: null,
      }
    const failure = this.failures.get(accelerator.version)
    return {
      answer: {
        installed: true,
        build: name,
        npu,
        accelerators: [
          {
            name: OPENVINO,
            device: 'npu',
            version: accelerator.version,
            size_bytes: accelerator.size,
            prepared: await exists(join(this.dirOf(accelerator.version), OWNER_MARKER)),
            ...(failure ? { reason: failure } : {}),
          },
        ],
        error: null,
      },
      accelerator,
    }
  }

  async list(): Promise<LiteRtLmAccelerators> {
    return (await this.offered()).answer
  }

  /** The prepared OpenVINO libraries of the active release: what an NPU load passes the host. */
  async libsDir(): Promise<string | undefined> {
    const { accelerator } = await this.offered()
    if (!accelerator) return undefined
    const dir = this.dirOf(accelerator.version)
    return (await exists(join(dir, OWNER_MARKER))) ? dir : undefined
  }

  async prepare(request: LiteRtLmPrepareRequest): Promise<LiteRtLmPrepareResult> {
    if (this.preparing)
      throw new AtomicCoreError(
        'ENGINE_INSTALL_IN_PROGRESS',
        'The LiteRT-LM accelerator is already being prepared; wait for that to finish.'
      )
    this.preparing = true
    try {
      const { answer, accelerator } = await this.offered()
      const wanted =
        request.accelerators && request.accelerators.length > 0 ? request.accelerators : [OPENVINO]
      const summary: LiteRtLmPrepareResult['accelerators'] = []
      for (const name of wanted) {
        if (name !== OPENVINO) {
          summary.push({ name, prepared: false, reason: `LiteRT-LM has no ${name} accelerator.` })
          continue
        }
        if (!accelerator) {
          summary.push({
            name,
            prepared: false,
            reason: answer.error ?? 'This computer has no Intel NPU LiteRT-LM has models for.',
          })
          continue
        }
        summary.push(await this.prepareOpenVino(accelerator, request.proxy ?? null))
      }
      return { accelerators: summary }
    } finally {
      this.preparing = false
    }
  }

  private async prepareOpenVino(
    accelerator: ManifestAccelerator,
    proxy: ProxyConfig | null
  ): Promise<LiteRtLmPrepareResult['accelerators'][number]> {
    const emit = (
      stage: 'started' | 'downloading' | 'done' | 'failed',
      fraction: number | null,
      reason?: string
    ) =>
      this.deps.emit('litert-lm:accelerators', {
        accelerator: OPENVINO,
        stage,
        fraction,
        ...(reason !== undefined ? { reason } : {}),
      })
    const target = this.dirOf(accelerator.version)
    if (await exists(join(target, OWNER_MARKER))) {
      emit('done', 1)
      return { name: OPENVINO, prepared: true }
    }
    const stamp = this.now()
    const work = join(this.deps.tmpDir, `openvino-${accelerator.version}-${stamp}`)
    const staging = `${target}.incoming-${stamp}`
    try {
      emit('started', 0)
      await mkdir(work, { recursive: true })
      const wheel = join(work, accelerator.name)
      await this.deps.download(
        `litert-lm-${OPENVINO}-${accelerator.version}`,
        {
          url: accelerator.url,
          save_path: wheel,
          sha256: accelerator.sha256,
          size: accelerator.size,
          ...(proxy ? { proxy } : {}),
        },
        (fraction) => emit('downloading', fraction)
      )
      const unpacked = join(work, 'unpacked')
      await extractArchive(wheel, unpacked)
      const libs = join(unpacked, 'openvino', 'libs')
      if (!(await exists(libs))) throw new Error('the OpenVINO wheel has no openvino/libs')
      await rm(staging, { recursive: true, force: true })
      await mkdir(join(staging, '..'), { recursive: true })
      await rename(libs, staging)
      await writeFile(join(staging, OWNER_MARKER), 'atomic-chat\n')
      await rm(target, { recursive: true, force: true })
      await rename(staging, target)
      this.failures.delete(accelerator.version)
      emit('done', 1)
      return { name: OPENVINO, prepared: true }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.failures.set(accelerator.version, reason)
      await rm(staging, { recursive: true, force: true }).catch(() => {})
      emit('failed', null, reason)
      return { name: OPENVINO, prepared: false, reason }
    } finally {
      await rm(work, { recursive: true, force: true }).catch(() => {})
    }
  }
}
