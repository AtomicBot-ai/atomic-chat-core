import { describe, expect, it } from 'vitest'
import { DOCKER_POOLS_EXHAUSTED, hostStepFailureError, poolsExhaustedIn } from './host-step-failure.js'
import { DOCKER_ADDRESS_POOLS_INSTRUCTION } from './linux-docker-network.js'

/** The executor's log_tail on the 3.10 host (F-4): the step, systemctl's words, then the journal tail. */
const POOLS_TAIL = [
  'docker-service failed: systemctl enable --now docker exited with 1',
  'Job for docker.service failed because the control process exited with error code.',
  'journalctl -u docker.service:',
  'failed to start daemon: Error initializing network controller: error creating default "bridge" network: ' +
    `${DOCKER_POOLS_EXHAUSTED}`,
].join('\n')
const RESTART_TAIL = `nvidia-runtime failed: systemctl restart docker exited with 1\n${DOCKER_POOLS_EXHAUSTED.toUpperCase()}`

describe('poolsExhaustedIn', () => {
  it.each<[string | undefined, boolean]>([
    [POOLS_TAIL, true],
    [RESTART_TAIL, true],
    ['packages failed: apt-get install exited with 100', false],
    [undefined, false],
  ])('%j: %s', (tail, expected) => {
    expect(poolsExhaustedIn(tail)).toBe(expected)
  })
})

describe('hostStepFailureError (task 2.23, F-4)', () => {
  it.each<[string, string | undefined, boolean | 'unknown' | undefined, RegExp, RegExp | null, string]>([
    [
      'no bip or pools in daemon.json: the host routes cover the defaults',
      POOLS_TAIL,
      false,
      /because the routes on this machine \(often a full-tunnel VPN\) cover every address range/,
      /daemon\.json \("default-address-pools" or "bip"\) are used up/,
      POOLS_TAIL,
    ],
    [
      'pools or bip set in daemon.json: the configured ranges are used up or overlap',
      POOLS_TAIL,
      true,
      /the address ranges set in \/etc\/docker\/daemon\.json \("default-address-pools" or "bip"\) are used up or overlap routes/,
      /full-tunnel VPN/,
      POOLS_TAIL,
    ],
    [
      'daemon.json unread: the likely cause, not asserted',
      RESTART_TAIL,
      'unknown',
      /most often because the routes on this machine/,
      null,
      RESTART_TAIL,
    ],
    [
      'nobody read daemon.json: the same hedged words',
      POOLS_TAIL,
      undefined,
      /most often because/,
      null,
      POOLS_TAIL,
    ],
    [
      'any other failure: the old message, the tail kept',
      'packages failed: apt-get install exited with 100',
      false,
      /^Preparing the system did not finish\.$/,
      null,
      'packages failed: apt-get install exited with 100',
    ],
    [
      'no tail (an app that does not forward it): the receipt id, as before',
      undefined,
      undefined,
      /^Preparing the system did not finish\.$/,
      null,
      'receipt-7',
    ],
    [
      'a blank tail counts as none',
      '  \n',
      undefined,
      /^Preparing the system did not finish\.$/,
      null,
      'receipt-7',
    ],
  ])('%s', (_name, logTail, configured, message, notMessage, details) => {
    const error = hostStepFailureError(
      { receipt_id: 'receipt-7', ...(logTail === undefined ? {} : { log_tail: logTail }) },
      configured
    )
    expect(error.code).toBe('MANAGED_PREREQUISITE_BLOCKED')
    expect(error.message).toMatch(message)
    if (notMessage !== null) expect(error.message).not.toMatch(notMessage)
    expect(error.details).toBe(details)
  })

  it('the routes cause uses the plan warning instruction; every pool text quotes Docker', () => {
    const routes = hostStepFailureError({ receipt_id: 'r', log_tail: POOLS_TAIL }, false).message
    expect(routes).toContain(DOCKER_ADDRESS_POOLS_INSTRUCTION)
    for (const configured of [true, false, 'unknown' as const])
      expect(hostStepFailureError({ receipt_id: 'r', log_tail: POOLS_TAIL }, configured).message).toContain(
        DOCKER_POOLS_EXHAUSTED
      )
  })
})
