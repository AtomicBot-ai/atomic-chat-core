import type { networkInterfaces } from 'node:os'
import { describe, expect, it } from 'vitest'
import { isDialable } from './lan.js'
import { defaultRouteAddress, interfaceAddresses, lanAddresses } from './lan-probe.js'

type Interfaces = ReturnType<typeof networkInterfaces>

const v4 = (address: string, internal = false) => ({
  address,
  netmask: '255.255.255.0',
  family: 'IPv4' as const,
  mac: '00:00:00:00:00:00',
  internal,
  cidr: `${address}/24`,
})
const v6 = (address: string) => ({
  address,
  netmask: 'ffff:ffff:ffff:ffff::',
  family: 'IPv6' as const,
  mac: '00:00:00:00:00:00',
  internal: false,
  cidr: `${address}/64`,
  scopeid: 0,
})

describe('interfaceAddresses', () => {
  it('keeps the IPv4 addresses of every interface, in a stable order', () => {
    const read = (): Interfaces => ({
      en1: [v4('10.0.0.9')],
      en0: [v6('fe80::1'), v4('192.168.1.5')],
      lo0: [v4('127.0.0.1', true)],
      down0: undefined,
    })
    expect(interfaceAddresses(read)).toEqual([
      { name: 'en0', address: '192.168.1.5' },
      { name: 'en1', address: '10.0.0.9' },
      { name: 'lo0', address: '127.0.0.1' },
    ])
  })
})

describe('lanAddresses', () => {
  it('puts the default-route address first and hides what nobody can dial', async () => {
    const addresses = await lanAddresses({
      interfaces: () => ({
        en1: [v4('10.0.0.9')],
        en0: [v4('192.168.1.5')],
        docker0: [v4('172.17.0.1')],
        lo0: [v4('127.0.0.1', true)],
      }),
      defaultRoute: async () => '192.168.1.5',
    })
    expect(addresses).toEqual(['192.168.1.5', '10.0.0.9'])
  })

  it('still answers when there is no route to anywhere', async () => {
    expect(
      await lanAddresses({
        interfaces: () => ({ en0: [v4('192.168.1.5')] }),
        defaultRoute: async () => undefined,
      })
    ).toEqual(['192.168.1.5'])
  })

  it('never throws on this machine, and yields only dialable IPv4 literals', async () => {
    for (const address of await lanAddresses()) expect(isDialable(address)).toBe(true)
  })
})

/** A UDP socket that does what the test says instead of asking the OS for a route. */
function fakeSocket(behaviour: 'connects' | 'errors' | 'throws' | 'hangs' | 'no-address') {
  const closed: number[] = []
  let onError: ((error: Error) => void) | undefined
  return {
    closed,
    socket: {
      once: (_event: 'error', listener: (error: Error) => void) => {
        onError = listener
      },
      connect: (_port: number, _address: string, callback: () => void) => {
        if (behaviour === 'throws') throw new Error('ENETUNREACH')
        if (behaviour === 'errors') return void setImmediate(() => onError?.(new Error('ENETUNREACH')))
        if (behaviour === 'hangs') return
        setImmediate(callback)
      },
      address: () => {
        if (behaviour === 'no-address') throw new Error('not bound')
        return { address: '192.168.1.5' }
      },
      close: () => {
        closed.push(1)
        // A second close throws on a real socket; the lookup must never trip over that.
        if (closed.length > 1) throw new Error('Not running')
      },
    },
  }
}

describe('defaultRouteAddress', () => {
  it.each([
    ['the local end of the connected socket', 'connects', '192.168.1.5'],
    ['nothing when the network is unreachable', 'errors', undefined],
    ['nothing when connecting throws outright', 'throws', undefined],
    ['nothing when the socket cannot say where it is', 'no-address', undefined],
    ['nothing once the lookup has taken too long', 'hangs', undefined],
  ] as const)('answers %s, and always closes the socket', async (_what, behaviour, expected) => {
    const fake = fakeSocket(behaviour)
    expect(await defaultRouteAddress(30, () => fake.socket)).toBe(expected)
    expect(fake.closed).toHaveLength(1)
  })

  it('answers an IPv4 literal or nothing, without sending anything, and within its timeout', async () => {
    const started = Date.now()
    const address = await defaultRouteAddress(500)
    expect(Date.now() - started).toBeLessThan(2000)
    if (address !== undefined) expect(address).toMatch(/^\d{1,3}(\.\d{1,3}){3}$/)
  })
})
