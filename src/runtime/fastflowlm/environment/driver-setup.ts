import type { FastFlowLmAccelerators, FastFlowLmDriverSetup } from '../../../contracts/index.js'
import type { PreparationHost } from './plan.js'

const linuxGuide = 'https://lemonade-server.ai/flm_npu_linux.html'
const amdDrivers = 'https://www.amd.com/en/support/download/drivers.html'
const diagnosticBlockers = ['driver-problem', 'driver-unknown', 'device-access-unknown']
const driverBlockers = ['driver-missing', 'driver-version-unconfirmed', 'firmware-unconfirmed']

/** Commands are fixed documentation, selected from the server facts, never helper input. */
export function driverSetup(
  facts: FastFlowLmAccelerators,
  host: PreparationHost
): FastFlowLmDriverSetup | undefined {
  if (
    facts.ready ||
    host.arch !== 'x64' ||
    !facts.devices.some((d) => d.generation === 'xdna2') ||
    facts.blockers.some((b) => ['device-busy', 'probe-inconclusive', 'ambiguous-npu'].includes(b)) ||
    !facts.blockers.some((b) =>
      [...driverBlockers, ...diagnosticBlockers, 'device-access-denied', 'xrt-device-unavailable'].includes(b)
    )
  )
    return undefined
  if (host.os === 'windows' && host.version === '11')
    return {
      title: 'Check the AMD NPU driver',
      steps: [
        'Check the NPU status in Device Manager. If it is disabled or reports an error, resolve that condition before reinstalling a driver.',
        'On the Windows server, download and install the NPU driver using AMD’s driver download page.',
        'Follow the AMD installer, restart Windows if requested, then check the NPU again.',
      ],
      commands: [],
      links: [{ label: 'AMD driver downloads', url: amdDrivers }],
    }
  if (host.os !== 'linux') return undefined
  const setup: FastFlowLmDriverSetup = {
    title: 'Set up the Linux NPU driver',
    steps: [
      'Run these commands on the Linux server, not on the computer displaying this page.',
      'Atomic Server installs FastFlowLM with its XRT libraries. System driver and firmware setup is separate.',
    ],
    commands: ['uname -r', 'modinfo amdxdna'],
    links: [{ label: 'Linux NPU setup guide', url: linuxGuide }],
  }
  const needsDriver = facts.blockers.some((b) => driverBlockers.includes(b))
  if (host.mutable !== true) {
    setup.steps.push(
      'Use your distribution’s driver and firmware setup instructions; package commands are not provided for an unknown or immutable system.'
    )
  } else if (
    needsDriver &&
    host.distribution === 'ubuntu' &&
    ['24.04', '25.10'].includes(host.version ?? '')
  ) {
    setup.commands = [
      'sudo add-apt-repository ppa:lemonade-team/stable',
      'sudo apt update',
      'sudo apt install amdxdna-dkms',
    ]
    setup.steps.push(
      'The DKMS driver needs matching headers for the running kernel. Follow the guide if the package does not support your kernel or Secure Boot requires key enrollment.'
    )
  } else if (needsDriver && host.distribution === 'ubuntu' && host.version === '26.04') {
    setup.commands = ['sudo apt update', 'sudo apt install linux-firmware', 'sudo modprobe amdxdna']
    setup.steps.push(
      'Use the distribution kernel with amdxdna support. If the module is missing, follow the guide for kernel setup.'
    )
  } else if (needsDriver && host.distribution === 'arch') {
    setup.commands = ['sudo pacman -Syu linux-firmware', 'sudo modprobe amdxdna']
    setup.steps.push(
      'The pacman command updates the system as well as firmware. Use a kernel with amdxdna support (7.0+); for older or custom kernels follow the guide instead of replacing your kernel blindly.'
    )
  } else {
    setup.steps.push('Follow the guide for your distribution and running kernel before installing packages.')
  }
  if (facts.blockers.includes('device-access-denied')) {
    setup.commands.push('ls -l /dev/accel/')
    setup.steps.push(
      'Grant the server account access to the NPU device using your distribution’s device-permission setup.'
    )
  }
  setup.steps.push(
    'After driver or firmware changes, restart the server machine when required, then check the NPU again. Atomic Server handles a low memlock limit separately.'
  )
  return setup
}
