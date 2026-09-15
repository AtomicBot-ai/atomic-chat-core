import { describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../contracts/index.js'
import type { BackendVersion } from './types.js'
import {
  compareBackendVersionsForSort,
  compareVersions,
  isConcreteVersionBackend,
  isWindowsBackend,
  parseBackendVersion,
  parseBinaryVersion,
  parseBuildNumber,
  parseRustU32,
  releaseTagRank,
  stripBom,
  validateBackendString,
} from './version.js'

describe('stripBom / parseRustU32', () => {
  it('drops BOMs and whitespace', () => {
    expect(stripBom('\uFEFF b10344/win-cpu-x64 \uFEFF')).toBe('b10344/win-cpu-x64')
  })
  it.each([
    ['42', 42],
    ['+7', 7],
    ['4294967295', 4294967295],
    ['4294967296', undefined],
    ['-1', undefined],
    ['1.0', undefined],
    ['', undefined],
  ])('parseRustU32(%j) = %j', (input, expected) => {
    expect(parseRustU32(input)).toBe(expected)
  })
})

describe('compareVersions (Rust test_compare_versions)', () => {
  it.each([
    ['1.0', '2.0', -1],
    ['2.0', '1.0', 1],
    ['1.0', '1.0', 0],
    ['1.0.1', '1.0', 1],
    ['450.80.02', '450.80.02', 0],
    ['525.60.13', '450.80.02', 1],
    ['10', '2', 1],
    ['', '452.39', -1],
    ['581.14', '581.15', -1],
    ['581.15', '581.15', 0],
  ])('compareVersions(%j, %j) = %j', (a, b, expected) => {
    expect(compareVersions(a, b)).toBe(expected)
  })
})

describe('parseBackendVersion (Rust test_parse_backend_version)', () => {
  it.each([
    ['b7523', 7523],
    ['b7524', 7524],
    ['7525', 7525],
    ['v100', 100],
    ['invalid', 0],
    ['v1.0.0', 0],
  ])('parseBackendVersion(%j) = %j', (input, expected) => {
    expect(parseBackendVersion(input)).toBe(expected)
  })
  it('keeps the unified-tag quirk: "b10018-1.3.0" parses to 0 (PLAN.md decision 15)', () => {
    expect(parseBackendVersion('b10018-1.3.0')).toBe(0)
    expect(parseBackendVersion('turboquant-macos-arm64-e3dad20')).toBe(0)
  })
})

describe('releaseTagRank / parseBuildNumber', () => {
  it.each([
    ['b10344', 10344],
    ['b9999', 9999],
    ['b10018-1.3.0', undefined],
    ['custom-build', undefined],
    ['10344', undefined],
    ['b', undefined],
  ])('releaseTagRank(%j) = %j', (input, expected) => {
    expect(releaseTagRank(input)).toBe(expected)
  })
  it.each([
    ['b6325', 6325],
    ['b10018-1.3.0', null],
    ['6325', null],
    ['\uFEFFb6325', null],
  ])('parseBuildNumber(%j) = %j', (input, expected) => {
    expect(parseBuildNumber(input)).toBe(expected)
  })
})

describe('parseBinaryVersion (Rust test_parse_binary_version)', () => {
  it.each([
    ['version: 10205 (1e2259952)\nbuilt with Clang', 10205],
    ['warning\nversion: 9222 (9a532ae4b)\n', 9222],
    ['version: 0.1.0-dev (build 10405, commit e79e4bf66)\nbuilt with Apple clang', 10405],
    ['unknown version', undefined],
    ['version: 0.1.0-dev (commit abc)', undefined],
    ['version: 0.1.0-dev (commit abc)\nversion: 12 (x)', 12],
  ])('parseBinaryVersion(%j) = %j', (input, expected) => {
    expect(parseBinaryVersion(input)).toBe(expected)
  })
})

describe('compareBackendVersionsForSort', () => {
  const b = (version: string, backend: string, order = 0): BackendVersion => ({ version, backend, order })
  const sorted = (list: BackendVersion[]) =>
    [...list].sort(compareBackendVersionsForSort).map((x) => `${x.version}/${x.backend}`)

  it('ranks release tags numerically, newest first (b9999 < b10344)', () => {
    expect(sorted([b('b9999', 'x', 5), b('b10344', 'x', 0)])).toEqual(['b10344/x', 'b9999/x'])
  })
  it('lets a newer remote tag beat an installed build with a huge order', () => {
    expect(sorted([b('b10205', 'macos-arm64', 1_800_000_000), b('b10344', 'macos-arm64', 0)])).toEqual([
      'b10344/macos-arm64',
      'b10205/macos-arm64',
    ])
  })
  it('puts a tagged build before an untagged one, and untagged ones by install order', () => {
    expect(
      sorted([
        b('custom-build', 'macos-arm64', 1),
        b('another-build', 'macos-arm64', 2),
        b('b1', 'macos-arm64', 0),
      ])
    ).toEqual(['b1/macos-arm64', 'another-build/macos-arm64', 'custom-build/macos-arm64'])
  })
  it('compares two untagged Windows builds by their numeric part before order', () => {
    expect(sorted([b('v7524', 'win-cpu-x64', 9), b('v7525', 'win-cpu-x64', 1)])).toEqual([
      'v7525/win-cpu-x64',
      'v7524/win-cpu-x64',
    ])
  })
  it('falls through to version string desc, then backend name asc', () => {
    expect(sorted([b('b7523', 'backend-b'), b('b7523', 'backend-a'), b('zzz', 'x'), b('aaa', 'x')])).toEqual([
      'b7523/backend-a',
      'b7523/backend-b',
      'zzz/x',
      'aaa/x',
    ])
  })
  it('isWindowsBackend', () => {
    expect(isWindowsBackend('win-cpu-x64')).toBe(true)
    expect(isWindowsBackend('linux-cpu-x64')).toBe(false)
  })
})

describe('isConcreteVersionBackend', () => {
  it.each([
    ['b10344/win-cpu-x64', true],
    ['\uFEFFb10344/win-cpu-x64', true],
    ['latest/win-cpu-x64', false],
    ['none', false],
    ['', false],
    [undefined, false],
    [null, false],
    ['b10344', false],
  ])('isConcreteVersionBackend(%j) = %j', (input, expected) => {
    expect(isConcreteVersionBackend(input)).toBe(expected)
  })
})

describe('validateBackendString (Rust test_validate_backend_string_*)', () => {
  it('splits and trims a valid string', () => {
    expect(validateBackendString('b7524/linux-common_cpus-x64')).toEqual(['b7524', 'linux-common_cpus-x64'])
    expect(validateBackendString(' b7524 / x ')).toEqual(['b7524', 'x'])
  })
  it.each(['invalid-format', 'a/b/c', '/x', 'b7524/ '])('rejects %j with INVALID_ARGUMENT', (input) => {
    expect(() => validateBackendString(input)).toThrow(AtomicCoreError)
    try {
      validateBackendString(input)
    } catch (err) {
      expect((err as AtomicCoreError).code).toBe('INVALID_ARGUMENT')
    }
  })
})
