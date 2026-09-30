/**
 * What a `failed` host-step receipt becomes as the operation's error (task 2.23, finding F-4).
 *
 * The privileged step runs outside the core, as root; all the core gets back is the app's receipt.
 * Since task 2.23 the receipt may carry the step's own `log_tail` (the executor's summary of the
 * failed step, with the tail of docker.service's journal when Docker did not start, aeef103). The
 * core never believes it as evidence of anything done, but it does read it for a cause it knows how
 * to explain: Docker refusing to start because the host's routes — typically a full-tunnel VPN —
 * cover every one of its default address pools. That failure otherwise reaches the user as "did not
 * finish", with the real reason buried in the journal (3.10 acceptance run, F-2/F-4).
 *
 * The cause is recognised by Docker's own words wherever they appear in the tail: `docker-service`
 * (`enable --now`) is where the 3.10 host hit it, and the approved restart after the runtime
 * configuration fails the same way on the same host. Nothing here runs as root or changes the
 * executor; the raw tail stays in `details` either way.
 */
import type { ErrorBody, ManagedHostReceipt } from '../../contracts/index.js'
import { DOCKER_ADDRESS_POOLS_INSTRUCTION } from './linux-docker-network.js'

/** dockerd's own message when no default address pool is free (libnetwork `ipamutils`). */
export const DOCKER_POOLS_EXHAUSTED = 'all predefined address pools have been fully subnetted'

/**
 * The operation error for a `failed` receipt: `MANAGED_PREREQUISITE_BLOCKED`, a message that names a
 * recognised cause and its fix, and `details` holding the raw log tail (or, without one, the
 * receipt id, as before task 2.23).
 */
export function hostStepFailureError(
  receipt: Pick<ManagedHostReceipt, 'receipt_id' | 'log_tail'>
): ErrorBody {
  const tail = receipt.log_tail?.trim() ?? ''
  const details = tail === '' ? receipt.receipt_id : tail
  if (tail.toLowerCase().includes(DOCKER_POOLS_EXHAUSTED)) {
    return {
      code: 'MANAGED_PREREQUISITE_BLOCKED',
      message:
        'Preparing the system did not finish: Docker could not start, because the routes on this machine ' +
        '(often a full-tunnel VPN) cover every address range Docker uses for its networks by default ' +
        `("${DOCKER_POOLS_EXHAUSTED}"). ${DOCKER_ADDRESS_POOLS_INSTRUCTION}`,
      details,
    }
  }
  return { code: 'MANAGED_PREREQUISITE_BLOCKED', message: 'Preparing the system did not finish.', details }
}
