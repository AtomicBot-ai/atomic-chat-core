/**
 * Whether Docker will find an address range for its default bridge on this machine (task 2.23,
 * finding F-4), read before anything is installed or started.
 *
 * When `dockerd` starts it gives the `docker0` bridge the first subnet of its predefined pools that
 * overlaps no route in the host's routing table. A full-tunnel VPN (`0.0.0.0/1` and `128.0.0.0/1`
 * through `tun*`, the 3.10 acceptance host) overlaps all of them, and the daemon exits with "all
 * predefined address pools have been fully subnetted" — the recipe's `docker-service` step fails after
 * the user consented, and systemd parks the unit in `start-limit-hit`. `bip` or `default-address-pools`
 * in `/etc/docker/daemon.json` replace that search, so either one set means the user already chose.
 *
 * The routes come from `/proc/net/route`: the kernel's main IPv4 table, the one Docker's own overlap
 * check reads (netlink `RouteList` without a table filter), always present, no binary on `PATH`
 * needed. The default route has no destination network and never counts; Docker skips it too.
 *
 * The pools are Docker's compiled-in defaults, moby `libnetwork/ipamutils/utils.go`
 * (`localScopeDefaultNetworks`): `172.17.0.0/16`, `172.18.0.0/16`, `172.19.0.0/16`,
 * `172.20.0.0/14`, `172.24.0.0/14` and `172.28.0.0/14` split into /16s, and `192.168.0.0/16` split
 * into /20s — 31 candidate subnets.
 *
 * Pure: the probe reads the file and `daemon.json`, `assessLinux` turns the answer into a plan
 * warning (never a blocker: the VPN may be switched off, and the fix is the user's own
 * configuration, which the recipe never edits).
 */

/** An IPv4 network as a 32-bit unsigned address and a prefix length. */
export interface Ipv4Cidr {
  address: number
  prefix: number
}

/** Docker's default local pools: each `base` is split into subnets of `/size` (see the header). */
const DOCKER_DEFAULT_POOLS: ReadonlyArray<{ base: string; size: number }> = [
  { base: '172.17.0.0/16', size: 16 },
  { base: '172.18.0.0/16', size: 16 },
  { base: '172.19.0.0/16', size: 16 },
  { base: '172.20.0.0/14', size: 16 },
  { base: '172.24.0.0/14', size: 16 },
  { base: '172.28.0.0/14', size: 16 },
  { base: '192.168.0.0/16', size: 20 },
]

const toDotted = (address: number): string =>
  [address >>> 24, (address >>> 16) & 0xff, (address >>> 8) & 0xff, address & 0xff].join('.')

const format = (cidr: Ipv4Cidr): string => `${toDotted(cidr.address)}/${cidr.prefix}`

const maskOf = (prefix: number): number => (prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0)

/** `a.b.c.d/n`, or a bare address as a /32. Null for anything else (IPv6, `default`, out of range). */
export function parseIpv4Cidr(text: string): Ipv4Cidr | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/.exec(text.trim())
  if (match === null) return null
  const octets = match.slice(1, 5).map(Number)
  const prefix = match[5] === undefined ? 32 : Number(match[5])
  if (octets.some((octet) => octet > 255) || prefix > 32) return null
  const address =
    (((octets[0] as number) << 24) |
      ((octets[1] as number) << 16) |
      ((octets[2] as number) << 8) |
      (octets[3] as number)) >>>
    0
  return { address: (address & maskOf(prefix)) >>> 0, prefix }
}

/** Every subnet Docker would try for a network, in its own order. */
export const DOCKER_DEFAULT_POOL_SUBNETS: readonly string[] = DOCKER_DEFAULT_POOLS.flatMap(
  ({ base, size }) => {
    const pool = parseIpv4Cidr(base) as Ipv4Cidr
    const count = 2 ** (size - pool.prefix)
    const step = 2 ** (32 - size)
    return Array.from({ length: count }, (_, index) =>
      format({ address: pool.address + index * step, prefix: size })
    )
  }
)

/** Two networks overlap when the wider one contains the other's network address. */
function overlaps(a: Ipv4Cidr, b: Ipv4Cidr): boolean {
  const mask = maskOf(Math.min(a.prefix, b.prefix))
  return (a.address & mask) >>> 0 === (b.address & mask) >>> 0
}

/** One `/proc/net/route` hex field (the kernel prints the network-order word as a host-order number). */
function hexWord(field: string | undefined): number | null {
  if (field === undefined || !/^[0-9A-Fa-f]{8}$/.test(field)) return null
  const value = Number.parseInt(field, 16)
  // Both supported architectures (x86_64, aarch64) are little-endian: the first octet is the low byte.
  return (
    (((value & 0xff) << 24) |
      (((value >>> 8) & 0xff) << 16) |
      (((value >>> 16) & 0xff) << 8) |
      (value >>> 24)) >>>
    0
  )
}

const prefixOf = (mask: number): number => {
  let bits = 0
  while (bits < 32 && ((mask << bits) & 0x80000000) !== 0) bits += 1
  return bits
}

/**
 * The destinations of `/proc/net/route` (main IPv4 table), in CIDR form, the default route left out.
 * Null when the file could not be read — an unread table is no evidence either way.
 */
export function parseProcNetRoute(text: string | null): string[] | null {
  if (text === null) return null
  const routes: string[] = []
  for (const raw of text.split('\n').slice(1)) {
    const fields = raw.trim().split(/\s+/)
    const destination = hexWord(fields[1])
    const mask = hexWord(fields[7])
    if (destination === null || mask === null) continue
    const prefix = prefixOf(mask)
    if (prefix === 0) continue // the default route
    routes.push(format({ address: (destination & maskOf(prefix)) >>> 0, prefix }))
  }
  return routes
}

/**
 * The routes that leave Docker no default subnet: every one of the 31 overlaps at least one of
 * `routes`. Returns the routes that overlap any pool (what a person has to change), or null when
 * some default subnet is still free — Docker then just takes that one.
 */
export function routesCoveringDockerPools(routes: readonly string[]): string[] | null {
  const parsed = routes
    .map((text) => ({ text, cidr: parseIpv4Cidr(text) }))
    .filter(
      (route): route is { text: string; cidr: Ipv4Cidr } => route.cidr !== null && route.cidr.prefix > 0
    )
  const pools = DOCKER_DEFAULT_POOL_SUBNETS.map((subnet) => parseIpv4Cidr(subnet) as Ipv4Cidr)
  if (!pools.every((pool) => parsed.some((route) => overlaps(route.cidr, pool)))) return null
  const involved = parsed.filter((route) => pools.some((pool) => overlaps(route.cidr, pool)))
  return [...new Set(involved.map((route) => route.text))]
}

/**
 * Whether `/etc/docker/daemon.json` sets `bip` or `default-address-pools`, either of which replaces
 * Docker's default pool search. `'unknown'` when the file exists but could not be read or parsed.
 */
export function daemonJsonSetsAddressPools(read: {
  text: string | null
  unreadable: boolean
}): boolean | 'unknown' {
  if (read.unreadable) return 'unknown'
  if (read.text === null) return false
  try {
    const parsed = JSON.parse(read.text) as { 'bip'?: unknown; 'default-address-pools'?: unknown }
    const bip = typeof parsed.bip === 'string' && parsed.bip.trim() !== ''
    const pools = Array.isArray(parsed['default-address-pools']) && parsed['default-address-pools'].length > 0
    return bip || pools
  } catch {
    return 'unknown'
  }
}

/** A plan warning: shown before consent, never blocks it, and never part of `plan_digest`. */
export interface LinuxPlanWarning {
  code: 'docker-address-pools-overlap-routes'
  text: string
  params?: Record<string, string>
}

/** What a person does about it; the same words in the plan warning and in the failed step's error. */
export const DOCKER_ADDRESS_POOLS_INSTRUCTION =
  "Exclude Docker's ranges (172.17.0.0/16 to 172.31.0.0/16 and 192.168.0.0/16) from the VPN, or set " +
  '"default-address-pools" (or "bip") in /etc/docker/daemon.json to a range no route uses, before continuing.'

/**
 * The F-4 warning: Docker is not running yet (not installed, or its service inactive), every default
 * subnet overlaps a non-default route, and `daemon.json` sets neither `bip` nor
 * `default-address-pools`. Anything this probe could not read suppresses it rather than guessing.
 */
export function dockerAddressPoolWarning(input: {
  dockerRunning: boolean
  addressPoolsConfigured: boolean | 'unknown'
  routes: readonly string[] | null
}): LinuxPlanWarning | null {
  if (input.dockerRunning || input.addressPoolsConfigured !== false || input.routes === null) return null
  const covering = routesCoveringDockerPools(input.routes)
  if (covering === null) return null
  return {
    code: 'docker-address-pools-overlap-routes',
    text:
      'Docker will not be able to start: every address range it uses for its networks by default is ' +
      `covered by the route${covering.length > 1 ? 's' : ''} ${covering.join(', ')} (often a full-tunnel VPN). ` +
      DOCKER_ADDRESS_POOLS_INSTRUCTION,
    params: { routes: covering.join(',') },
  }
}
