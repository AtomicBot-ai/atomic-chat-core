/**
 * `windows.enable-wsl` (change `add-tensorrt-llm-windows`, task 2.4, design D2): the one privileged
 * thing Atomic Chat ever asks for on Windows. The app runs `atomic-chat-core.exe host-step exec
 * <request>` through UAC; the executor runs exactly `wsl --install --no-distribution` — the WSL
 * package from the Store and the Windows components it needs — and then `wsl --status`, which says
 * whether a WSL 2 VM can start now or only after a restart.
 *
 * It takes no parameter. Nothing a client, a request file or a person could choose reaches the
 * elevated process: no distribution name, no path, no flag. And it never runs `wsl.exe` with a
 * distribution (`-d`, `--exec`, `--import`, …): an elevated `wsl.exe` registers and starts
 * distributions for the elevated token — another user, or another mount namespace of the same one —
 * where the app would never find them (microsoft/WSL#9690). Importing is the unelevated core's job.
 *
 * Its outcome: `completed` when WSL answers `--status` right away, `reboot-required` when the install
 * succeeded but WSL cannot start until Windows restarts (or the installer said so with 3010), `failed`
 * with the installer's exit code and output otherwise. `wsl.exe` here is the bare name; the Windows
 * executor's I/O resolves it to `%SystemRoot%\System32\wsl.exe`, never `PATH`.
 */

import type { EnableWslStepParameters, Sha256Digest } from '../../contracts/index.js'
import { canonicalDigest } from '../../runtime/environment/index.js'

export const ENABLE_WSL_RECIPE_ID = 'windows.enable-wsl'

/** `ERROR_SUCCESS_REBOOT_REQUIRED`: the installer succeeded and Windows must restart before it applies. */
export const REBOOT_REQUIRED_EXIT_CODE = 3010

/** The recipe as data: the two argv it runs, frozen, and what its digest is computed from. */
export const ENABLE_WSL_RECIPE = Object.freeze({
  recipe_id: ENABLE_WSL_RECIPE_ID,
  install: Object.freeze(['wsl.exe', '--install', '--no-distribution']) as readonly string[],
  verify: Object.freeze(['wsl.exe', '--status']) as readonly string[],
  reboot_required_exit_code: REBOOT_REQUIRED_EXIT_CODE,
})

export const ENABLE_WSL_RECIPE_DIGEST: Sha256Digest = canonicalDigest({
  recipe_id: ENABLE_WSL_RECIPE.recipe_id,
  install: [...ENABLE_WSL_RECIPE.install],
  verify: [...ENABLE_WSL_RECIPE.verify],
  reboot_required_exit_code: ENABLE_WSL_RECIPE.reboot_required_exit_code,
})

/** The digest of the (empty) parameters: what a step and its receipt carry. */
export function enableWslParametersDigest(parameters: EnableWslStepParameters): Sha256Digest {
  return canonicalDigest(parameters)
}

export const ENABLE_WSL_PARAMETERS_DIGEST: Sha256Digest = enableWslParametersDigest({})

export type EnableWslValidation =
  { ok: true; parameters: EnableWslStepParameters } | { ok: false; problems: string[] }

/** The only valid parameters are none: any key at all is refused. */
export function validateEnableWslParameters(value: unknown): EnableWslValidation {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, problems: ['parameters must be an object'] }
  }
  const keys = Object.keys(value)
  return keys.length === 0
    ? { ok: true, parameters: {} }
    : { ok: false, problems: [`windows.enable-wsl takes no parameters (got ${keys.sort().join(', ')})`] }
}

/** What the Windows provisioner binds a `windows.enable-wsl` step to (`EnableWslBinding`). */
export const ENABLE_WSL_BINDING = Object.freeze({
  recipe_id: ENABLE_WSL_RECIPE_ID,
  recipe_digest: ENABLE_WSL_RECIPE_DIGEST,
  parameters_digest: ENABLE_WSL_PARAMETERS_DIGEST,
})
