import { describe, expect, it } from 'vitest'
import { DynamicTrustedHosts, socketAddressLiteral } from './dynamic-hosts.js'
import { isValidHost } from './gates.js'

/** What the listener checks a request against: the configured hosts plus the group for its socket. */
const trusted = (hosts: DynamicTrustedHosts, localAddress?: string) => hosts.groupFor(localAddress)

// The five tests of the app's `dynamic_hosts.rs`, against the core's own `isValidHost`.
describe('DynamicTrustedHosts', () => {
  it('trusts nothing until something is known', () => {
    const hosts = new DynamicTrustedHosts()
    expect(hosts.groupFor()).toEqual([])
    expect(hosts.groupFor('127.0.0.1')).toEqual([])
    expect(hosts.groupFor('0.0.0.0')).toEqual([])
  })

  it('lets the tunnel name pass host validation only while it is set', () => {
    const hosts = new DynamicTrustedHosts()
    const header = 'calm-river-demo.trycloudflare.com'
    expect(isValidHost(header, trusted(hosts))).toBe(false)

    hosts.setTunnelHost('Calm-River-Demo.TryCloudflare.com')
    expect(hosts.tunnelHost()).toBe(header)
    expect(isValidHost(header, trusted(hosts))).toBe(true)
    // A different quick-tunnel name is still a stranger.
    expect(isValidHost('other-name.trycloudflare.com', trusted(hosts))).toBe(false)

    hosts.clearTunnelHost()
    expect(isValidHost(header, trusted(hosts))).toBe(false)
  })

  it('trusts a LAN client for the address it actually reached', () => {
    const group = trusted(new DynamicTrustedHosts(), '192.168.1.5')
    expect(isValidHost('192.168.1.5:1337', group)).toBe(true)
    expect(isValidHost('192.168.1.5', group)).toBe(true)
    // Another address of the same network is not this socket's address.
    expect(isValidHost('192.168.1.6:1337', group)).toBe(false)
    // The rebinding shape: an attacker's domain resolving to the LAN address.
    expect(isValidHost('evil.example:1337', group)).toBe(false)
  })

  it('matches the header spelling for IPv4-mapped and IPv6 socket addresses', () => {
    const hosts = new DynamicTrustedHosts()
    expect(isValidHost('10.0.0.7:1337', trusted(hosts, '::ffff:10.0.0.7'))).toBe(true)
    expect(isValidHost('[fd00::10]:1337', trusted(hosts, 'fd00::10'))).toBe(true)
  })

  it('clears instead of trusting the empty string when the tunnel host is blank', () => {
    const hosts = new DynamicTrustedHosts()
    hosts.setTunnelHost('x.trycloudflare.com')
    hosts.setTunnelHost('   ')
    expect(hosts.tunnelHost()).toBeUndefined()
    expect(hosts.groupFor()).toEqual([])
  })

  it('strips a trailing dot and answers the tunnel name together with the socket address', () => {
    const hosts = new DynamicTrustedHosts()
    hosts.setTunnelHost(' calm-river-demo.trycloudflare.com. ')
    expect(hosts.groupFor('192.168.1.5')).toEqual(['calm-river-demo.trycloudflare.com', '192.168.1.5'])
  })

  it.each([
    ['the wildcard that would allow every host', '*'],
    ['a wildcard label', '*.trycloudflare.com'],
    ['a URL', 'https://calm.trycloudflare.com'],
    ['a host with a port', 'calm.trycloudflare.com:443'],
    ['a host with a path', 'calm.trycloudflare.com/v1'],
    ['a host with a space in it', 'calm river.trycloudflare.com'],
    ['a label starting with a hyphen', '-calm.trycloudflare.com'],
  ])('never accepts %s as the tunnel name', (_what, value) => {
    const hosts = new DynamicTrustedHosts()
    hosts.setTunnelHost('calm.trycloudflare.com')
    hosts.setTunnelHost(value)
    expect(hosts.tunnelHost()).toBeUndefined()
    // In particular, nothing here can make `isValidHost` allow a stranger.
    expect(isValidHost('evil.example', hosts.groupFor('127.0.0.1'))).toBe(false)
  })
})

describe('socketAddressLiteral', () => {
  it.each([
    ['nothing', undefined, undefined],
    ['null', null, undefined],
    ['the empty string', '', undefined],
    ['IPv4 loopback', '127.0.0.1', undefined],
    ['anything in 127/8', '127.10.20.30', undefined],
    ['IPv4 unspecified', '0.0.0.0', undefined],
    ['IPv6 loopback', '::1', undefined],
    ['IPv6 loopback, written out', '0:0:0:0:0:0:0:1', undefined],
    ['IPv6 unspecified', '::', undefined],
    ['mapped loopback', '::ffff:127.0.0.1', undefined],
    ['mapped unspecified', '::ffff:0.0.0.0', undefined],
    ['a LAN IPv4 address', '192.168.1.5', '192.168.1.5'],
    ['a CGNAT (Tailscale) address', '100.64.0.7', '100.64.0.7'],
    ['a mapped LAN address', '::ffff:192.168.1.5', '192.168.1.5'],
    ['a mapped address in hex groups', '::ffff:c0a8:105', '192.168.1.5'],
    ['a mapped address in upper case', '::FFFF:10.0.0.7', '10.0.0.7'],
    ['a unique-local IPv6 address', 'fd00::10', '[fd00::10]'],
    ['an IPv6 address in upper case', 'FD00::10', '[fd00::10]'],
    ['a link-local address with its zone', 'fe80::1%en0', '[fe80::1]'],
    ['an address whose low group is 1 but is not loopback', '1::', '[1::]'],
    ['an address that only looks like loopback', '::1:1', '[::1:1]'],
    ['something that is not an address', 'not-an-address', undefined],
  ])('%s → %s', (_what, address, literal) => {
    expect(socketAddressLiteral(address)).toBe(literal)
  })
})
