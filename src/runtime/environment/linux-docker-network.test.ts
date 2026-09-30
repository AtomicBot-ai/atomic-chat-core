import { describe, expect, it } from 'vitest'
import {
  DOCKER_ADDRESS_POOLS_INSTRUCTION,
  DOCKER_DEFAULT_POOL_SUBNETS,
  daemonJsonSetsAddressPools,
  dockerAddressPoolWarning,
  parseIpv4Cidr,
  parseProcNetRoute,
  routesCoveringDockerPools,
} from './linux-docker-network.js'

const HEADER = 'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT'
/** One `/proc/net/route` line: destination and mask as the kernel prints them (hex, host byte order). */
const line = (iface: string, destination: string, mask: string): string =>
  `${iface}\t${destination}\t00000000\t0001\t0\t0\t0\t${mask}\t0\t0\t0`

/**
 * The full-tunnel VPN host of the 3.10 acceptance run (F-4): the VPN's `0.0.0.0/1` and `128.0.0.0/1`
 * over `tun2`, the tunnel's own /24, the Wi-Fi LAN and its default route.
 */
const FULL_TUNNEL = [
  HEADER,
  line('wlp2s0', '00000000', '00000000'), // default via the LAN router
  line('tun2', '00000000', '00000080'), // 0.0.0.0/1
  line('tun2', '00000080', '00000080'), // 128.0.0.0/1
  line('tun2', '0000080A', '00FFFFFF'), // 10.8.0.0/24
  line('wlp2s0', '0001A8C0', '00FFFFFF'), // 192.168.1.0/24
].join('\n')

describe('Docker address pools against the routing table (F-4)', () => {
  it("lists Docker's 31 default subnets: 172.17–172.31 as /16s and 192.168.0.0/16 as /20s", () => {
    expect(DOCKER_DEFAULT_POOL_SUBNETS).toHaveLength(31)
    expect(DOCKER_DEFAULT_POOL_SUBNETS.slice(0, 3)).toEqual([
      '172.17.0.0/16',
      '172.18.0.0/16',
      '172.19.0.0/16',
    ])
    expect(DOCKER_DEFAULT_POOL_SUBNETS).toContain('172.31.0.0/16')
    expect(DOCKER_DEFAULT_POOL_SUBNETS).not.toContain('172.16.0.0/16')
    expect(DOCKER_DEFAULT_POOL_SUBNETS.at(15)).toBe('192.168.0.0/20')
    expect(DOCKER_DEFAULT_POOL_SUBNETS.at(-1)).toBe('192.168.240.0/20')
  })

  it.each<[string, ReturnType<typeof parseIpv4Cidr>]>([
    ['10.8.0.0/24', { address: 0x0a080000, prefix: 24 }],
    ['0.0.0.0/1', { address: 0, prefix: 1 }],
    ['10.8.0.1', { address: 0x0a080001, prefix: 32 }],
    ['192.168.1.5/24', { address: 0xc0a80100, prefix: 24 }],
    ['256.0.0.0/8', null],
    ['10.0.0.0/33', null],
    ['default', null],
    ['fe80::/64', null],
  ])('parses %s', (text, expected) => {
    expect(parseIpv4Cidr(text)).toEqual(expected)
  })

  it('reads every route but the default one from /proc/net/route, in CIDR form, with its interface', () => {
    expect(parseProcNetRoute(FULL_TUNNEL)).toEqual([
      { destination: '0.0.0.0/1', device: 'tun2' },
      { destination: '128.0.0.0/1', device: 'tun2' },
      { destination: '10.8.0.0/24', device: 'tun2' },
      { destination: '192.168.1.0/24', device: 'wlp2s0' },
    ])
    // A host route (mask all ones) is a /32; a blank or header-only file has no routes at all.
    expect(parseProcNetRoute([HEADER, line('eth0', '0100000A', 'FFFFFFFF')].join('\n'))).toEqual([
      { destination: '10.0.0.1/32', device: 'eth0' },
    ])
    expect(parseProcNetRoute(`${HEADER}\n`)).toEqual([])
    // Nothing read is not "no routes": the caller must not warn, and must not claim the table is clean.
    expect(parseProcNetRoute(null)).toBeNull()
    // A line that is not the kernel's shape is skipped, never guessed at.
    expect(
      parseProcNetRoute([HEADER, 'eth0\tzz\t00\t0001', line('tun0', '00000080', '00000080')].join('\n'))
    ).toEqual([{ destination: '128.0.0.0/1', device: 'tun0' }])
  })

  const via = (device: string, ...destinations: string[]) =>
    destinations.map((destination) => ({ destination, device }))
  it.each<[string, ReturnType<typeof via>, string[] | null]>([
    // 0.0.0.0/1 ends at 127.255.255.255: only the upper half of the tunnel lies over Docker's pools.
    [
      'a full-tunnel VPN covers every pool',
      via('tun2', '0.0.0.0/1', '128.0.0.0/1', '10.8.0.0/24'),
      ['128.0.0.0/1'],
    ],
    // The LAN inside 192.168.0.0/20 lies over a pool too, but the tunnel covers that one already:
    // only what causes the overlap is named (review round 1).
    [
      'the 3.10 laptop: the tunnel, not the home LAN beside it',
      [...via('tun2', '0.0.0.0/1', '128.0.0.0/1'), ...via('wlp2s0', '192.168.1.0/24')],
      ['128.0.0.0/1'],
    ],
    [
      'two routes needed together: 172.16.0.0/12 and 192.168.0.0/16',
      via('wg0', '172.16.0.0/12', '192.168.0.0/16'),
      ['172.16.0.0/12', '192.168.0.0/16'],
    ],
    [
      'a narrower route whose pool a wider one already covers is not named',
      via('wg0', '172.17.0.0/16', '172.16.0.0/12', '192.168.0.0/16'),
      ['172.16.0.0/12', '192.168.0.0/16'],
    ],
    [
      'a home LAN inside 192.168.0.0/20 leaves the 172 pools free',
      via('eth0', '192.168.1.0/24', '10.8.0.0/24'),
      null,
    ],
    ['172.17.0.0/16 alone leaves the next pool free', via('eth0', '172.17.0.0/16'), null],
    ['no routes at all', [], null],
    ['an unparsable destination is ignored', via('eth0', 'nonsense', '10.0.0.0/8'), null],
  ])('%s', (_name, routes, expected) => {
    expect(routesCoveringDockerPools(routes)?.map((route) => route.destination) ?? null).toEqual(expected)
  })

  it.each<[string, { text: string | null; unreadable: boolean }, boolean | 'unknown']>([
    ['no daemon.json', { text: null, unreadable: false }, false],
    ['only the NVIDIA runtime', { text: '{"runtimes":{"nvidia":{}}}', unreadable: false }, false],
    ['a bip', { text: '{"bip":"172.30.99.1/24"}', unreadable: false }, true],
    [
      'default-address-pools',
      { text: '{"default-address-pools":[{"base":"10.200.0.0/16","size":24}]}', unreadable: false },
      true,
    ],
    [
      'an empty bip and no pools',
      { text: '{"bip":"","default-address-pools":[]}', unreadable: false },
      false,
    ],
    ['a file that does not parse', { text: '{ nope', unreadable: false }, 'unknown'],
    ['a file that could not be read', { text: null, unreadable: true }, 'unknown'],
  ])('daemon.json with %s', (_name, read, expected) => {
    expect(daemonJsonSetsAddressPools(read)).toBe(expected)
  })

  it('warns, naming the routes and the instruction, only when Docker is down, every pool is covered and daemon.json sets neither key', () => {
    const covered = [
      { destination: '0.0.0.0/1', device: 'tun2' },
      { destination: '128.0.0.0/1', device: 'tun2' },
      { destination: '192.168.1.0/24', device: 'wlp2s0' },
    ]
    const warning = dockerAddressPoolWarning({
      dockerRunning: false,
      addressPoolsConfigured: false,
      routes: covered,
    })
    expect(warning).toEqual({
      code: 'docker-address-pools-overlap-routes',
      text: expect.stringContaining('the route 128.0.0.0/1 via tun2 (often a full-tunnel VPN) covers every'),
      params: { routes: '128.0.0.0/1', devices: 'tun2' },
    })
    expect(warning?.text).toContain(DOCKER_ADDRESS_POOLS_INSTRUCTION)

    // Each condition alone suppresses it: a running Docker already has its bridge, a configured
    // pool or bip is the user's own fix, an unread routing table or daemon.json is not evidence.
    const none = [
      { dockerRunning: true, addressPoolsConfigured: false as const, routes: covered },
      { dockerRunning: false, addressPoolsConfigured: true as const, routes: covered },
      { dockerRunning: false, addressPoolsConfigured: 'unknown' as const, routes: covered },
      { dockerRunning: false, addressPoolsConfigured: false as const, routes: null },
      {
        dockerRunning: false,
        addressPoolsConfigured: false as const,
        routes: [{ destination: '192.168.1.0/24', device: 'wlp2s0' }],
      },
    ]
    for (const input of none) expect(dockerAddressPoolWarning(input), JSON.stringify(input)).toBeNull()
  })
})

describe('the warning with several routes', () => {
  it('names each route with its interface and the interfaces once', () => {
    const warning = dockerAddressPoolWarning({
      dockerRunning: false,
      addressPoolsConfigured: false,
      routes: [
        { destination: '172.16.0.0/12', device: 'wg0' },
        { destination: '192.168.0.0/16', device: 'wg0' },
      ],
    })
    expect(warning?.text).toContain(
      'the routes 172.16.0.0/12 via wg0, 192.168.0.0/16 via wg0 (often a full-tunnel VPN) cover every'
    )
    expect(warning?.params).toEqual({ routes: '172.16.0.0/12,192.168.0.0/16', devices: 'wg0' })
  })
})
