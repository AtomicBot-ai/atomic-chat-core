/**
 * What a `failed` host-step receipt becomes as the operation's error (task 2.23, finding F-4).
 *
 * The privileged step runs outside the core, as root; all the core gets back is the app's receipt.
 * Since task 2.23 the receipt may carry the step's own `log_tail` (the executor's summary of the
 * failed step, with the tail of docker.service's journal when Docker did not start, aeef103). The
 * core never believes it as evidence of anything done, but it does read it for a cause it knows how
 * to explain: dockerd finding no free address pool for its bridge. That failure otherwise reaches the
 * user as "did not finish", with the real reason buried in the journal (3.10 acceptance run, F-2/F-4).
 *
 * Docker prints the same words for two causes, and the message follows what `daemon.json` says
 * (review round 1): with no `bip`/`default-address-pools` there, its default pools are covered by the
 * host's routes — typically a full-tunnel VPN; with one of them set, the ranges the user configured
 * are the ones used up or overlapped. When `daemon.json` could not be read, the message says which is
 * the likely one rather than asserting it.
 *
 * The cause is recognised by Docker's own words wherever they appear in the tail: `docker-service`
 * (`enable --now`) is where the 3.10 host hit it, and the approved restart after the runtime
 * configuration fails the same way on the same host. Nothing here runs as root or changes the
 * executor; the raw tail stays in `details` either way.
 */
import type { ErrorBody, ManagedHostReceipt } from '../../contracts/index.js'
import { DOCKER_ADDRESS_POOLS_INSTRUCTION } from './linux-docker-network.js'

/** dockerd's own message when no address pool is free (libnetwork `ipamutils`). */
export const DOCKER_POOLS_EXHAUSTED = 'all predefined address pools have been fully subnetted'

/** Whether a step's log tail shows dockerd finding no free address pool. */
export function poolsExhaustedIn(logTail: string | undefined): boolean {
  return (logTail ?? '').toLowerCase().includes(DOCKER_POOLS_EXHAUSTED)
}

/**
 * The operation error for a `failed` receipt: `MANAGED_PREREQUISITE_BLOCKED`, a message that names a
 * recognised cause and its fix, and `details` holding the raw log tail (or, without one, the
 * receipt id, as before task 2.23). `addressPoolsConfigured` is what `/etc/docker/daemon.json` says
 * when the receipt arrived (`bip` or `default-address-pools` set); undefined when nobody read it.
 */
export function hostStepFailureError(
  receipt: Pick<ManagedHostReceipt, 'receipt_id' | 'log_tail'>,
  addressPoolsConfigured?: boolean | 'unknown'
): ErrorBody {
  const tail = receipt.log_tail?.trim() ?? ''
  const details = tail === '' ? receipt.receipt_id : tail
  const failed = 'Preparing the system did not finish: Docker could not start'
  if (!poolsExhaustedIn(tail)) {
    return { code: 'MANAGED_PREREQUISITE_BLOCKED', message: 'Preparing the system did not finish.', details }
  }
  const words = `("${DOCKER_POOLS_EXHAUSTED}")`
  const message =
    addressPoolsConfigured === true
      ? `${failed}: the address ranges set in /etc/docker/daemon.json ("default-address-pools" or ` +
        `"bip") are used up or overlap routes on this machine ${words}. Set ranges there that no route ` +
        'uses, then try again.'
      : addressPoolsConfigured === false
        ? `${failed}, because the routes on this machine (often a full-tunnel VPN) cover every address ` +
          `range Docker uses for its networks by default ${words}. ${DOCKER_ADDRESS_POOLS_INSTRUCTION}`
        : `${failed}: it found no free address range for its networks ${words}, most often because the ` +
          'routes on this machine (a full-tunnel VPN) cover its default ranges, or because the ranges set ' +
          `in /etc/docker/daemon.json are used up. ${DOCKER_ADDRESS_POOLS_INSTRUCTION}`
  return { code: 'MANAGED_PREREQUISITE_BLOCKED', message, details }
}
