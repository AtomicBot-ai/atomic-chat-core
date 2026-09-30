/**
 * The pure part of the live tests' host helper, run without any ATOMIC_LIVE variable: how the gids a
 * process holds are read from `/proc/<pid>/status`. The relogin scenario decides its premise from them,
 * so an unreadable file must come out as "unknown" and never as "holds no group".
 */
import { describe, expect, it } from 'vitest'
import { parseProcessGroups, pickLaunchCard, processGroups } from '../helpers/live-linux-host.js'

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
