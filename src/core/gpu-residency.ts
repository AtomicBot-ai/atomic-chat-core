/**
 * Composition of GPU residency for `create.ts` (task 2.15, spec `gpu-residency`, design D10): the one
 * `GpuResidency` of this core, whose claim hooks every GPU engine is given — both llama.cpp providers,
 * MLX, `tensorrt-llm` and image generation — over what each of them reports it holds, plus the
 * containers a previous core left that startup could not confirm stopped.
 *
 * How an occupant is stopped is decided here, and only ever inside this core's scope:
 *  - a local runtime's session goes through the facade's own `unload` (`LocalSessions`), exactly as a
 *    client's unload would: per-model serialization, and the cross-process model claim released only
 *    once the runtime confirmed the stop — never over a live process or an unconfirmed container. Any
 *    acquire of that model still pending — a first load, or a reload in place of a ready one — is
 *    cancelled first, so the unload is not queued behind it;
 *  - the image model through the diffusion service's own `unloadModel`;
 *  - a leftover container by reconciling it again (`leftoverContainers`).
 * Sessions of another scope (the app vs the CLI core), and sessions another process registered, are
 * never listed, so never stopped.
 *
 * Every part is read at claim time: the runtimes exist before the diffusion service, the Docker
 * executor and the facade are wired, and the hooks are handed to the runtimes as they are built.
 */
import type { LocalProviderId } from '../contracts/index.js'
import type { DiffusionService } from '../diffusion/index.js'
import type { GpuOccupancy, LocalRuntime } from '../runtime/index.js'
import type { AtomicCore } from './atomic-core.js'
import { GpuResidency } from './gpu/index.js'
import type { ResidencyOccupant } from './gpu/index.js'

/** The provider id image generation claims the GPU under. */
export const DIFFUSION_GPU_PROVIDER = 'diffusion'

export interface WireGpuResidencyOptions {
  /** The core's runtime table, read at every claim. */
  runtimes: Map<LocalProviderId, LocalRuntime>
  /** The image-generation service, once wired. */
  diffusion: () => Pick<DiffusionService, 'gpuOccupancy' | 'unloadModel'> | undefined
  /** The containers a previous core left unconfirmed (`leftoverContainers`). */
  leftovers: () => ResidencyOccupant[]
  /** The facade, once constructed: what stops a local session the way a client's unload does. */
  sessions: () => Pick<AtomicCore, 'cancelLoad' | 'unload'>
}

export function wireGpuResidency(options: WireGpuResidencyOptions): GpuResidency {
  const stopSession = (provider: LocalProviderId, occupant: GpuOccupancy) => async () => {
    const sessions = options.sessions()
    // Always, whatever state the occupant reports (final review I-3): a reload in place of a `ready`
    // model holds its per-model transition while it stops the old session and then waits for this
    // very claim's turn, so the unload below would queue behind it forever. Cancelling makes that
    // reload give up and release the transition; with no acquire pending it does nothing.
    sessions.cancelLoad(provider, occupant.model_id)
    const result = await sessions.unload(provider, occupant.model_id)
    if (!result.success) throw new Error(result.error ?? `The unload of ${occupant.model_id} failed.`)
  }
  const occupants = (): ResidencyOccupant[] => {
    const local = [...options.runtimes].flatMap(([provider, runtime]) =>
      (runtime.gpuOccupancy?.() ?? []).map((occupant) => ({
        ...occupant,
        provider,
        evict: stopSession(provider, occupant),
      }))
    )
    const diffusion = options.diffusion()
    const image = (diffusion?.gpuOccupancy() ?? []).map((occupant) => ({
      ...occupant,
      provider: DIFFUSION_GPU_PROVIDER,
      evict: () => diffusion?.unloadModel() ?? Promise.resolve(),
    }))
    return [...local, ...image, ...options.leftovers()]
  }
  return new GpuResidency({ occupants })
}
