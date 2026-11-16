import { basename } from 'node:path'
import { release } from 'node:os'
import type { SystemInfo } from '../contracts/index.js'
import type { ProbeDeps } from './probe-common.js'
import { strataHostFacts, type StrataHostDetails } from './strata.js'

const kfdNodes = '/sys/class/kfd/kfd/topology/nodes'
async function linuxHipDevices(deps: ProbeDeps) {
  const nodes = (await deps.fs.readdir(kfdNodes)).filter((id) => /^\d+$/.test(id)).sort((a, b) => +a - +b)
  const result = new Map<string, { ordinal: number; architecture: string }>()
  let ordinal = 0
  for (const node of nodes) {
    const properties = await deps.fs.readFile(kfdNodes + '/' + node + '/properties')
    const read = (field: string) => Number(new RegExp('^' + field + ' +([0-9]+)$', 'm').exec(properties)?.[1])
    const version = read('gfx_target_version'),
      simd = read('simd_count'),
      minor = read('drm_render_minor')
    if (version === 0 || simd === 0) continue
    if (!Number.isSafeInteger(version) || !Number.isSafeInteger(simd)) return new Map()
    const index = ordinal++
    if (!Number.isSafeInteger(minor)) continue
    const pci = basename(await deps.fs.readlink('/sys/class/drm/renderD' + minor + '/device').catch(() => ''))
    if (!/^[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]$/i.test(pci)) continue
    if (result.has(pci)) return new Map()
    result.set(pci, {
      ordinal: index,
      architecture:
        'gfx' +
        Math.floor(version / 10000) +
        (Math.floor(version / 100) % 100).toString(16) +
        (version % 100).toString(16),
    })
  }
  return result
}

async function identifySyclDevices(facts: ReturnType<typeof strataHostFacts>, deps: ProbeDeps) {
  const intel = facts.devices.filter((device) => device.vendor === 'intel')
  if (!intel.some((device) => device.architecture === 'intel-arc')) return
  const result = await deps
    .run('sycl-ls', [], 5000, { cwd: '/', env: { PATH: deps.env.PATH, LANG: 'C' } })
    .catch(() => null)
  if (!result) {
    // The native pack needs a driver, but does not require a system oneAPI installation.
    if (intel.length === 1 && intel[0]!.architecture === 'intel-arc') intel[0]!.ordinal = 0
    return
  }
  if (result.code !== 0) return
  const normalize = (text: string) =>
    text
      .toLowerCase()
      .replace(/\((?:r|tm)\)/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  const rows = [
    ...result.stdout.matchAll(/^\s*\[(?:ext_oneapi_)?level_zero:gpu:(\d+)\][^,\r\n]*,\s*([^\r\n]+)/gm),
  ]
  for (const device of intel) {
    if (device.architecture !== 'intel-arc' || !device.name) continue
    const name = normalize(device.name)
    if (intel.filter((candidate) => candidate.name && normalize(candidate.name) === name).length !== 1)
      continue
    const matches = rows.filter((row) => {
      const label = normalize(row[2]!)
      return label === name || label.startsWith(name + ' ')
    })
    const ordinal = Number(matches[0]?.[1])
    if (matches.length === 1 && Number.isSafeInteger(ordinal)) device.ordinal = ordinal
  }
}

/** Small additional ABI probes; none install drivers or execute a shell. */
export async function probeStrataHost(
  info: SystemInfo,
  deps: ProbeDeps,
  kernelRelease: () => string = release
) {
  const details: StrataHostDetails = {}
  if (deps.platform === 'win32') details.osVersion = kernelRelease()
  if (deps.platform === 'linux') {
    const [osRelease, libc, deviceTree] = await Promise.all([
      deps.fs.readFile('/etc/os-release').catch(() => ''),
      deps.run('getconf', ['GNU_LIBC_VERSION'], 5000).catch(() => null),
      info.cpu.arch === 'arm64' || info.cpu.arch === 'aarch64'
        ? deps.fs.readFile('/proc/device-tree/model').catch(() => '')
        : '',
    ])
    const field = (key: string) => new RegExp('^' + key + '="?([a-z0-9.]+)"?$', 'm').exec(osRelease)?.[1]
    const version = field('VERSION_ID'),
      distribution = field('ID')
    if (version) details.osVersion = version
    if (distribution) details.distribution = distribution
    const glibc = libc?.code === 0 ? /^glibc (\d+\.\d+)\s*$/.exec(libc.stdout)?.[1] : undefined
    if (glibc) details.glibcVersion = glibc
    details.spark = /^NVIDIA DGX Spark\0?\s*$/.test(deviceTree)
  }
  const facts = strataHostFacts(info, details)
  if (deps.platform === 'linux' && facts.devices.some((device) => device.vendor === 'amd')) {
    const devices = await linuxHipDevices(deps).catch(
      () => new Map<string, { ordinal: number; architecture: string }>()
    )
    for (const device of facts.devices) {
      if (device.vendor !== 'amd') continue
      const match = devices.get(device.id)
      if (match && (!device.architecture || device.architecture === match.architecture))
        Object.assign(device, match)
    }
  }
  if (deps.platform === 'linux') await identifySyclDevices(facts, deps)
  return facts
}
