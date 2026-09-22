/**
 * The addresses another device on the network can dial, for display only.
 *
 * Host validation does not depend on this list: the public listener trusts the local address of each
 * accepted socket (`server/public/dynamic-hosts.ts`), which stays correct across sleep/wake and
 * network changes. This only answers "what do I type on my phone?", so it may hide addresses that
 * would work but would confuse (a WSL or Docker bridge) without breaking anybody.
 *
 * Ported from: src-tauri/src/core/server/remote_access/lan.rs (image-generation line, `767ff6350`).
 */

/** One IPv4 address of one network interface. */
export interface InterfaceAddress {
  name: string
  address: string
}

/**
 * Interface-name prefixes of adapters another device cannot reach. Matched case-insensitively
 * against the start of the name.
 */
const VIRTUAL_INTERFACE_PREFIXES = [
  // Windows (the friendly alias)
  'vethernet',
  'virtualbox',
  'vmware',
  // Linux
  'docker',
  'br-',
  'veth',
  'virbr',
  // macOS
  'bridge',
  'utun',
  'awdl',
  'llw',
]

export function isVirtualInterface(name: string): boolean {
  const lower = name.trim().toLowerCase()
  return VIRTUAL_INTERFACE_PREFIXES.some((prefix) => lower.startsWith(prefix))
}

function octets(address: string): [number, number, number, number] | undefined {
  const parts = address.split('.')
  if (parts.length !== 4) return undefined
  const numbers = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN))
  if (numbers.some((n) => Number.isNaN(n) || n > 255)) return undefined
  return numbers as [number, number, number, number]
}

/**
 * Carrier-grade NAT space, which is where Tailscale hands out addresses. On macOS those live on a
 * `utun` interface, on Windows and Linux on a plainly named one; this keeps a mesh-VPN address
 * visible on all three.
 */
export function isSharedAddressSpace(address: string): boolean {
  const parsed = octets(address)
  return parsed !== undefined && parsed[0] === 100 && parsed[1] >= 64 && parsed[1] < 128
}

/** Not loopback, link-local, multicast, broadcast or unspecified — and an IPv4 literal at all. */
export function isDialable(address: string): boolean {
  const parsed = octets(address)
  if (!parsed) return false
  const [a, b, c, d] = parsed
  const loopback = a === 127
  const linkLocal = a === 169 && b === 254
  const multicast = a >= 224 && a <= 239
  const broadcast = a === 255 && b === 255 && c === 255 && d === 255
  const unspecified = a === 0 && b === 0 && c === 0 && d === 0
  return !(loopback || linkLocal || multicast || broadcast || unspecified)
}

/**
 * What to show, and in which order. The default-route address comes first because it is almost
 * always the one the user means.
 */
export function selectLanAddresses(
  interfaces: readonly InterfaceAddress[],
  defaultRoute?: string | undefined
): string[] {
  const selected: string[] = []
  const push = (address: string) => {
    if (isDialable(address) && !selected.includes(address)) selected.push(address)
  }
  if (defaultRoute !== undefined) push(defaultRoute)
  for (const { name, address } of interfaces) {
    if (isVirtualInterface(name) && !isSharedAddressSpace(address)) continue
    push(address)
  }
  return selected
}

/** Order by interface name, then numerically by address: the OS enumerates in no promised order. */
export function sortInterfaceAddresses(interfaces: readonly InterfaceAddress[]): InterfaceAddress[] {
  const key = (address: string) =>
    (octets(address) ?? [0, 0, 0, 0]).reduce((sum, part) => sum * 256 + part, 0)
  return [...interfaces].sort((left, right) =>
    left.name === right.name ? key(left.address) - key(right.address) : left.name < right.name ? -1 : 1
  )
}
