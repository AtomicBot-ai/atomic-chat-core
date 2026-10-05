/**
 * The Linux install recipe, run inside Atomic Chat's own WSL distribution (change
 * `add-tensorrt-llm-windows`, task 2.5; design D1, D3): the very executor the Linux host step runs
 * (`executeHostStep`) — the same refusals, digests, pinned keys, idempotent steps and result — with its
 * I/O pointed at the guest through the WSL transport instead of at this machine. Every command runs as
 * the guest's root, as one argv under `env -i` with the recipe's fixed environment (the same clean
 * environment `nodeHostStepDeps` gives `hostExec`), never through a shell. Nothing here is elevated on
 * Windows: root in a distribution the user owns gives no rights on Windows (D3).
 *
 * The request never touches a disk: it is built in memory from the parameters the plan validated, and
 * the result comes back to the caller. Keys are fetched on the Windows side and written into the guest.
 * A guest file is read with `cat` — text only, which is all the recipe compares (sources, `daemon.json`);
 * a binary key is only ever checked for existence.
 */
import type { GuestRecipeRunner } from '../../runtime/environment/index.js'
import type { WslDistributionTransport } from '../../runtime/wsl/index.js'
import { executeHostStep, type HostStepExecutorDeps } from './executor.js'
import { INSTALL_CONTAINER_RUNTIME_RECIPE } from './install-container-runtime.js'

/** Package installs: hours, as on Linux; everything else: minutes. */
const LONG_TIMEOUT_MS = 2 * 60 * 60_000
const COMMAND_TIMEOUT_MS = 10 * 60_000
const GUEST_ROOT = 'root'

export interface GuestHostStepOptions {
  fetch: typeof fetch
  signal: AbortSignal
  now?: () => number
}

const ENV = Object.entries(INSTALL_CONTAINER_RUNTIME_RECIPE.environment).map(
  ([key, value]) => `${key}=${value}`
)

/** `HostStepExecutorDeps` over the guest, for an in-memory request (`readRequest`/`writeResult` are the caller's). */
export function guestHostStepDeps(
  transport: WslDistributionTransport,
  options: GuestHostStepOptions
): HostStepExecutorDeps {
  const run = (argv: string[], timeoutMs = COMMAND_TIMEOUT_MS, input?: Buffer) =>
    transport.exec(argv, {
      user: GUEST_ROOT,
      timeoutMs,
      signal: options.signal,
      ...(input === undefined ? {} : { input }),
    })
  const must = async (argv: string[], input?: Buffer): Promise<void> => {
    const output = await run(argv, COMMAND_TIMEOUT_MS, input)
    if (output.code !== 0)
      throw new Error(`${argv.join(' ')} exited with ${String(output.code)}: ${output.stderr.trim()}`)
  }
  return {
    readRequest: async () => {
      throw new Error('the guest runner supplies the request itself')
    },
    writeResult: async () => undefined,
    readFile: async (path) => {
      if ((await run(['test', '-e', path])).code !== 0) return null
      const read = await run(['cat', '--', path])
      if (read.code !== 0)
        throw new Error(`could not read ${path} in the distribution: ${read.stderr.trim()}`)
      return new Uint8Array(Buffer.from(read.stdout, 'utf8'))
    },
    writeFile: async (path, data, mode) => {
      const temp = `${path}.atomic-tmp`
      await must(['mkdir', '-p', path.slice(0, path.lastIndexOf('/')) || '/'])
      await must(['tee', temp], Buffer.from(data))
      await must(['chmod', mode.toString(8), temp])
      await must(['mv', '-f', temp, path])
    },
    exec: (argv, call) =>
      run(['env', '-i', ...ENV, ...argv], call?.longRunning === true ? LONG_TIMEOUT_MS : COMMAND_TIMEOUT_MS),
    fetch: options.fetch,
    now: options.now ?? Date.now,
    invokingUid: null,
  }
}

/** The `GuestRecipeRunner` the Windows provisioner is given. */
export function createGuestRecipeRunner(options: {
  fetch: typeof fetch
  now?: () => number
}): GuestRecipeRunner {
  return async (transport, request, signal) => {
    const text = JSON.stringify({
      schema_version: 1,
      step_id: 'guest-recipe',
      operation_id: 'guest',
      action: request.recipe_id,
      recipe_id: request.recipe_id,
      recipe_digest: request.recipe_digest,
      parameters_digest: request.parameters_digest,
      nonce: 'guest',
      expected_operation_revision: 0,
      data_folder: '/',
      parameters: request.parameters,
    })
    const deps: HostStepExecutorDeps = {
      ...guestHostStepDeps(transport, {
        fetch: options.fetch,
        signal,
        ...(options.now === undefined ? {} : { now: options.now }),
      }),
      readRequest: async () => text,
      writeResult: async () => undefined,
    }
    const result = await executeHostStep('guest/guest-recipe.request.json', deps)
    return { outcome: result.outcome, log_tail: result.log_tail }
  }
}
