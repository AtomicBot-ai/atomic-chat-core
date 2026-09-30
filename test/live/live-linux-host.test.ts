/**
 * The pure part of the live tests' host helper, run without any ATOMIC_LIVE variable: how the gids a
 * process holds are read from `/proc/<pid>/status`. The relogin scenario decides its premise from them,
 * so an unreadable file must come out as "unknown" and never as "holds no group".
 */
import { describe, expect, it } from 'vitest'
import {
  DOCKER_POOLS,
  addressPoolWarningExpected,
  parseIpRoute,
  parseProcessGroups,
  pickLaunchCard,
  processGroups,
  routesCoveringDockerPools,
  setupPath,
} from '../helpers/live-linux-host.js'
import type { HostFacts } from '../helpers/live-linux-host.js'

const status = (gid: string, groups: string): string =>
  `Name:\tcore\nUid:\t1000\t1000\t1000\t1000\nGid:\t${gid}\nFDSize:\t64\nGroups:${groups}\nNStgid:\t42\n`

describe('parseProcessGroups', () => {
  it.each<[string, string, number[] | null]>([
    [
      'supplementary gids and the primary one',
      status('1000\t1000\t1000\t1000', ' 4 27 999 1000 '),
      [1000, 4, 27, 999],
    ],
    [
      'a primary gid that is the docker gid, with no supplementary ones',
      status('999\t999\t999\t999', ' '),
      [999],
    ],
    ['real and effective gids that differ', status('1000\t999\t1000\t999', ''), [1000, 999]],
    ['an empty Groups line does not swallow the next line', status('1000\t1000\t1000\t1000', ''), [1000]],
    ['text with neither line', 'Name:\tcore\n', null],
    ['an empty file', '', null],
  ])('reads %s', (_label, text, expected) => {
    expect(parseProcessGroups(text)).toEqual(expected)
  })
})

describe('processGroups', () => {
  it('is unknown (null), not an empty list, for a process whose status cannot be read', () => {
    expect(processGroups(2 ** 31 - 1)).toBeNull()
  })
})

describe('pickLaunchCard', () => {
  const GB = 1024 ** 3
  const card = (id: string, total: number | null, free: number | null) => ({
    id,
    total_bytes: total,
    free_bytes: free,
  })
  it.each<[string, ReturnType<typeof card>[], string | undefined]>([
    [
      'the most free memory (the spec desktop case)',
      [card('a', 24 * GB, 19 * GB), card('b', 24 * GB, 23.5 * GB)],
      'b',
    ],
    ['free memory before total', [card('a', 48 * GB, 10 * GB), card('b', 24 * GB, 20 * GB)], 'b'],
    ['equal free memory: the larger card', [card('a', 24 * GB, 20 * GB), card('b', 48 * GB, 20 * GB)], 'b'],
    [
      'a full tie: the first in nvidia-smi order',
      [card('a', 24 * GB, 20 * GB), card('b', 24 * GB, 20 * GB)],
      'a',
    ],
    ['a single card', [card('a', 8 * GB, 7 * GB)], 'a'],
    ['no card', [], undefined],
  ])('picks %s', (_label, gpus, expected) => {
    expect(pickLaunchCard(gpus)?.id).toBe(expected)
  })
})

/** `ip -4 route` on the 3.10 acceptance laptop with its full-tunnel VPN up (task 2.23, F-4). */
const FULL_TUNNEL = [
  'default via 192.168.1.1 dev wlp2s0 proto dhcp src 192.168.1.127 metric 600',
  '0.0.0.0/1 via 10.8.0.1 dev tun2',
  '10.8.0.0/24 dev tun2 proto kernel scope link src 10.8.0.2',
  '128.0.0.0/1 via 10.8.0.1 dev tun2',
  '192.168.1.0/24 dev wlp2s0 proto kernel scope link src 192.168.1.127 metric 600',
  'blackhole 10.99.0.0/16',
].join('\n')

describe('Docker address pools against ip -4 route (task 2.23, F-4)', () => {
  it("lists Docker's 31 default subnets", () => {
    expect(DOCKER_POOLS).toHaveLength(31)
    expect(DOCKER_POOLS[0]).toBe('172.17.0.0/16')
    expect(DOCKER_POOLS[14]).toBe('172.31.0.0/16')
    expect(DOCKER_POOLS.at(-1)).toBe('192.168.240.0/20')
  })

  it('reads every destination but the default route, a route type word skipped', () => {
    expect(parseIpRoute(FULL_TUNNEL)).toEqual([
      '0.0.0.0/1',
      '10.8.0.0/24',
      '128.0.0.0/1',
      '192.168.1.0/24',
      '10.99.0.0/16',
    ])
  })

  it.each<[string, string[], string[] | null]>([
    ['the full tunnel covers every pool', parseIpRoute(FULL_TUNNEL), ['128.0.0.0/1', '192.168.1.0/24']],
    ['the LAN alone leaves the 172 pools free', ['192.168.1.0/24'], null],
    ['nothing at all', [], null],
  ])('%s', (_label, routes, expected) => {
    expect(routesCoveringDockerPools(routes)).toEqual(expected)
  })
})

describe('what the live install expects of a starting state (task 2.23)', () => {
  const facts = (over: Partial<HostFacts>, docker: Partial<HostFacts['docker']> = {}): HostFacts =>
    ({
      family: 'apt',
      in_recipe: true,
      immutable: false,
      routes_covering_docker_pools: null,
      ...over,
      docker: {
        cli: '/usr/bin/docker',
        service_active: false,
        user_reaches_daemon: false,
        nvidia_runtime_loaded: false,
        nvidia_cdi: false,
        address_pools_configured: false,
        ...docker,
      },
    }) as HostFacts

  it('adopts only with a listed CDI device, never on a loaded nvidia runtime alone (F-5)', () => {
    expect(setupPath(facts({}, { user_reaches_daemon: true, nvidia_cdi: true }))).toBe('adopt')
    expect(setupPath(facts({}, { user_reaches_daemon: true, nvidia_runtime_loaded: true }))).toBe('complete')
  })

  it('expects the address-pool warning only when Docker is down, the pools covered and daemon.json silent (F-4)', () => {
    const covered = { routes_covering_docker_pools: ['128.0.0.0/1'] }
    expect(addressPoolWarningExpected(facts(covered))).toBe(true)
    expect(addressPoolWarningExpected(facts(covered, { service_active: true }))).toBe(false)
    expect(addressPoolWarningExpected(facts(covered, { address_pools_configured: true }))).toBe(false)
    expect(addressPoolWarningExpected(facts(covered, { address_pools_configured: null }))).toBe(false)
    expect(addressPoolWarningExpected(facts({}))).toBe(false)
  })
})
