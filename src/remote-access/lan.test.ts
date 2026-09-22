import { describe, expect, it } from 'vitest'
import {
  isDialable,
  isSharedAddressSpace,
  isVirtualInterface,
  selectLanAddresses,
  sortInterfaceAddresses,
} from './lan.js'

const iface = (name: string, address: string) => ({ name, address })

// The app's `lan.rs` tests, table for table.
describe('selectLanAddresses', () => {
  it('leads with the default-route address and does not repeat it', () => {
    expect(
      selectLanAddresses([iface('en1', '10.0.0.9'), iface('en0', '192.168.1.5')], '192.168.1.5')
    ).toEqual(['192.168.1.5', '10.0.0.9'])
  })

  it('drops addresses nobody can dial', () => {
    const interfaces = [
      iface('lo0', '127.0.0.1'),
      iface('en0', '169.254.12.1'),
      iface('en0', '0.0.0.0'),
      iface('en0', '224.0.0.251'),
      iface('en0', '255.255.255.255'),
    ]
    expect(selectLanAddresses(interfaces)).toEqual([])
    // A loopback "default route" (no network at all) is dropped too.
    expect(selectLanAddresses([], '127.0.0.1')).toEqual([])
  })

  it('hides virtual adapters on every OS', () => {
    const interfaces = [
      iface('vEthernet (WSL (Hyper-V firewall))', '172.22.0.1'),
      iface('VirtualBox Host-Only Network', '192.168.56.1'),
      iface('VMware Network Adapter VMnet8', '192.168.80.1'),
      iface('docker0', '172.17.0.1'),
      iface('br-3f1c2ab4', '172.18.0.1'),
      iface('veth9a1b', '172.19.0.1'),
      iface('virbr0', '192.168.122.1'),
      iface('bridge100', '192.168.64.1'),
      iface('utun4', '10.8.0.2'),
      iface('Wi-Fi', '192.168.1.20'),
    ]
    expect(selectLanAddresses(interfaces)).toEqual(['192.168.1.20'])
  })

  it('keeps a mesh-VPN address visible even on a utun interface', () => {
    expect(selectLanAddresses([iface('utun3', '100.101.102.103'), iface('utun4', '10.8.0.2')])).toEqual([
      '100.101.102.103',
    ])
    expect(isSharedAddressSpace('100.64.0.1')).toBe(true)
    expect(isSharedAddressSpace('100.127.255.254')).toBe(true)
    expect(isSharedAddressSpace('100.128.0.1')).toBe(false)
    expect(isSharedAddressSpace('100.63.0.1')).toBe(false)
    expect(isSharedAddressSpace('not an address')).toBe(false)
  })

  it('ignores anything that is not an IPv4 literal, including an IPv6 default route', () => {
    expect(selectLanAddresses([iface('en0', 'fd00::10'), iface('en0', '192.168.1.5')], 'fd00::1')).toEqual([
      '192.168.1.5',
    ])
  })
})

describe('isVirtualInterface', () => {
  it.each([
    ['  Docker0 ', true],
    ['BRIDGE100', true],
    ['awdl0', true],
    ['llw0', true],
    ['en0', false],
    ['Ethernet', false],
    ['eth0', false],
    ['wlan0', false],
  ])('%j → %s', (name, virtual) => expect(isVirtualInterface(name)).toBe(virtual))
})

describe('isDialable', () => {
  it.each([
    ['192.168.1.5', true],
    ['10.0.0.1', true],
    ['100.64.0.7', true],
    ['127.0.0.1', false],
    ['169.254.1.1', false],
    ['239.255.255.250', false],
    ['255.255.255.255', false],
    ['0.0.0.0', false],
    ['256.1.1.1', false],
    ['1.2.3', false],
    ['::1', false],
    ['', false],
  ])('%j → %s', (address, dialable) => expect(isDialable(address)).toBe(dialable))
})

describe('sortInterfaceAddresses', () => {
  it('orders by interface name, then numerically by address, without touching the input', () => {
    const input = [iface('en1', '10.0.0.9'), iface('en0', '192.168.1.10'), iface('en0', '192.168.1.9')]
    expect(sortInterfaceAddresses(input)).toEqual([
      iface('en0', '192.168.1.9'),
      iface('en0', '192.168.1.10'),
      iface('en1', '10.0.0.9'),
    ])
    expect(input[0]).toEqual(iface('en1', '10.0.0.9'))
  })
})
