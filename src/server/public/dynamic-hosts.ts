/**
 * Hosts the Local API Server trusts without the user typing them into Trusted Hosts.
 *
 * `isValidHost` rejects any `Host` header that is not loopback or listed in the configured trusted
 * hosts. That is the DNS-rebinding guard, and it stays byte for byte as it was. Two callers, though,
 * arrive with a `Host` nobody could have typed in advance:
 *
 *  - a Cloudflare quick tunnel, whose `<words>.trycloudflare.com` name is only known once
 *    `cloudflared` has printed it, and is new on every start;
 *  - a LAN client dialling this machine's own address, which changes with the network (sleep/wake,
 *    Wi-Fi switch, DHCP lease).
 *
 * Neither weakens the guard. A rebinding attack puts the *attacker's* domain in `Host`; it cannot
 * make the header equal the tunnel's real public name or the literal address of the socket the
 * request arrived on.
 *
 * Ported from: src-tauri/src/core/server/dynamic_hosts.rs (image-generation line, `767ff6350`).
 * ADR 2026-09-17-trust-the-tunnel-name-and-the-accepted-socket-address-per-request.
 */

import { isIPv4, isIPv6 } from 'node:net'

/** One or more dot-separated DNS labels: nothing that `isValidHost` would read as a wildcard. */
const BARE_HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/

export class DynamicTrustedHosts {
  private tunnel: string | undefined

  /**
   * Trust `host` (a bare hostname, no scheme, port or path) until cleared. Anything else clears it:
   * a blank value must not trust the empty string, and `*` must never reach `isValidHost`, where it
   * allows every host.
   */
  setTunnelHost(host: string): void {
    const value = host.trim().replace(/\.+$/, '').toLowerCase()
    this.tunnel = BARE_HOSTNAME.test(value) ? value : undefined
  }

  clearTunnelHost(): void {
    this.tunnel = undefined
  }

  tunnelHost(): string | undefined {
    return this.tunnel
  }

  /**
   * The extra trusted-hosts group for one request.
   *
   * `localAddress` is the local address of the accepted socket. It is trusted only when it says
   * something a loopback bind could not: an unspecified or loopback address adds nothing
   * (`isValidHost` already allows loopback), so a server bound to `127.0.0.1` gains no new names.
   */
  groupFor(localAddress?: string | null): string[] {
    const group: string[] = []
    if (this.tunnel !== undefined) group.push(this.tunnel)
    const literal = socketAddressLiteral(localAddress)
    if (literal !== undefined) group.push(literal)
    return group
  }
}

/** The `Host`-header spelling of a socket's local address, or `undefined` when it adds nothing. */
export function socketAddressLiteral(localAddress?: string | null): string | undefined {
  if (!localAddress) return undefined
  // A link-local address arrives with its zone (`fe80::1%en0`); a `Host` header never carries one.
  const address = unmapIpv4(localAddress.split('%')[0] ?? '')
  if (isIPv4(address)) {
    if (address === '0.0.0.0' || address.startsWith('127.')) return undefined
    return address
  }
  if (isIPv6(address)) {
    const lower = address.toLowerCase()
    if (isIpv6Unspecified(lower) || isIpv6Loopback(lower)) return undefined
    // `isValidHost` strips the port of a bracketed literal only when the trusted entry is bracketed too.
    return `[${lower}]`
  }
  return undefined
}

/**
 * A dual-stack listener reports IPv4 peers as `::ffff:a.b.c.d` (or, from some stacks, in the hex
 * form `::ffff:c0a8:105`), but the client wrote plain `a.b.c.d` in its `Host` header.
 */
function unmapIpv4(address: string): string {
  const lower = address.toLowerCase()
  if (!lower.startsWith('::ffff:')) return address
  const rest = lower.slice('::ffff:'.length)
  if (isIPv4(rest)) return rest
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(rest)
  if (!hex) return address
  const high = parseInt(hex[1] as string, 16)
  const low = parseInt(hex[2] as string, 16)
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`
}

/** The eight groups of an IPv6 literal, or `undefined` for a form this does not need to understand. */
function ipv6Groups(address: string): number[] | undefined {
  if (address.includes('.')) return undefined
  const [head, tail, ...extra] = address.split('::')
  if (head === undefined || extra.length > 0) return undefined
  const parse = (part: string) => (part === '' ? [] : part.split(':').map((group) => parseInt(group, 16)))
  const leading = parse(head)
  if (tail === undefined) return leading.length === 8 ? leading : undefined
  const trailing = parse(tail)
  const zeros = 8 - leading.length - trailing.length
  return zeros < 0 ? undefined : [...leading, ...new Array<number>(zeros).fill(0), ...trailing]
}

function isIpv6Unspecified(address: string): boolean {
  return ipv6Groups(address)?.every((group) => group === 0) === true
}

function isIpv6Loopback(address: string): boolean {
  const groups = ipv6Groups(address)
  return groups !== undefined && groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1
}
