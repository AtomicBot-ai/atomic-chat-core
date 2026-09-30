import { describe, expect, it } from 'vitest'
import { DOCKER_POOLS_EXHAUSTED, hostStepFailureError } from './host-step-failure.js'
import { DOCKER_ADDRESS_POOLS_INSTRUCTION } from './linux-docker-network.js'

/** The executor's log_tail on the 3.10 host (F-4): the step, systemctl's words, then the journal tail. */
const POOLS_TAIL = [
  'docker-service failed: systemctl enable --now docker exited with 1',
  'Job for docker.service failed because the control process exited with error code.',
  'journalctl -u docker.service:',
  'failed to start daemon: Error initializing network controller: error creating default "bridge" network: ' +
    `${DOCKER_POOLS_EXHAUSTED}`,
].join('\n')

describe('hostStepFailureError (task 2.23, F-4)', () => {
  it.each<[string, string | undefined, RegExp, string]>([
    [
      'the pools exhausted by the routes, on docker-service',
      POOLS_TAIL,
      /routes on this machine.*VPN/s,
      POOLS_TAIL,
    ],
    [
      'the same, on the approved restart after the runtime configuration',
      `nvidia-runtime failed: systemctl restart docker exited with 1\n${DOCKER_POOLS_EXHAUSTED.toUpperCase()}`,
      /routes on this machine/,
      `nvidia-runtime failed: systemctl restart docker exited with 1\n${DOCKER_POOLS_EXHAUSTED.toUpperCase()}`,
    ],
    [
      'any other failure: the old message, the tail kept',
      'packages failed: apt-get install exited with 100',
      /^Preparing the system did not finish\.$/,
      'packages failed: apt-get install exited with 100',
    ],
    [
      'no tail (an app that does not forward it): the receipt id, as before',
      undefined,
      /^Preparing the system did not finish\.$/,
      'receipt-7',
    ],
    ['a blank tail counts as none', '  \n', /^Preparing the system did not finish\.$/, 'receipt-7'],
  ])('%s', (_name, logTail, message, details) => {
    const error = hostStepFailureError({
      receipt_id: 'receipt-7',
      ...(logTail === undefined ? {} : { log_tail: logTail }),
    })
    expect(error.code).toBe('MANAGED_PREREQUISITE_BLOCKED')
    expect(error.message).toMatch(message)
    expect(error.details).toBe(details)
  })

  it('names the cause in the words the plan warning uses, with the same instruction', () => {
    const { message } = hostStepFailureError({ receipt_id: 'r', log_tail: POOLS_TAIL })
    expect(message).toContain(DOCKER_POOLS_EXHAUSTED)
    expect(message).toContain(DOCKER_ADDRESS_POOLS_INSTRUCTION)
  })
})
