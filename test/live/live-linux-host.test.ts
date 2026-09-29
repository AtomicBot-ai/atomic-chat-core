/**
 * The pure part of the live tests' host helper, run without any ATOMIC_LIVE variable: how the gids a
 * process holds are read from `/proc/<pid>/status`. The relogin scenario decides its premise from them,
 * so an unreadable file must come out as "unknown" and never as "holds no group".
 */
import { describe, expect, it } from 'vitest'
import { parseProcessGroups, processGroups } from '../helpers/live-linux-host.js'

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
