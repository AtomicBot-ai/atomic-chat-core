import { describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../../contracts/index.js'
import type { ManagedStageMarker } from './adapter.js'
import {
  advanceStage,
  exitErrorCode,
  isPortBindConflict,
  readContainerState,
  resolveReadinessTimeoutMs,
  stripDockerTimestamps,
} from './load-policy.js'

describe('resolveReadinessTimeoutMs', () => {
  it.each([
    ['the adapter value when there is no override', 90_000, undefined, 90_000],
    ['the override when there is one, even a shorter one', 90_000, 5_000, 5_000],
    ['the override when it is longer', 90_000, 900_000, 900_000],
  ])('takes %s', (_case, adapterMs, overrideMs, expected) => {
    expect(resolveReadinessTimeoutMs(adapterMs, overrideMs)).toBe(expected)
  })

  it.each([
    ['a zero adapter value', 0, undefined],
    ['a NaN adapter value', Number.NaN, undefined],
    ['a negative override', 90_000, -1],
    ['an infinite override', 90_000, Number.POSITIVE_INFINITY],
  ])('refuses %s', (_case, adapterMs, overrideMs) => {
    expect(() => resolveReadinessTimeoutMs(adapterMs, overrideMs)).toThrow(AtomicCoreError)
  })
})

describe('advanceStage', () => {
  const markers: ManagedStageMarker[] = [{ stage: 'initializing-engine', pattern: /Loading weights/ }]

  it.each([
    ['no markers: straight to initializing-engine', 'starting-container', [], '', 'initializing-engine'],
    [
      'markers, none seen yet: stays put',
      'starting-container',
      markers,
      'booting python\n',
      'starting-container',
    ],
    [
      'a marker in the tail moves it on',
      'starting-container',
      markers,
      'x\nLoading weights 1/4\n',
      'initializing-engine',
    ],
    [
      'never goes backwards once there',
      'initializing-engine',
      [{ stage: 'starting-container', pattern: /x/ }] as ManagedStageMarker[],
      'x\n',
      'initializing-engine',
    ],
  ] as const)('%s', (_case, current, list, tail, expected) => {
    expect(advanceStage(current, list, tail)).toBe(expected)
  })
})

describe('exitErrorCode', () => {
  it.each([
    ['out-of-memory', 'OUT_OF_MEMORY'],
    ['unsupported-model', 'MODEL_INCOMPATIBLE'],
    ['other', 'MODEL_LOAD_FAILED'],
  ] as const)('maps %s to %s', (kind, code) => {
    expect(exitErrorCode(kind)).toBe(code)
  })
})

describe('isPortBindConflict', () => {
  it.each([
    [
      'docker start losing the port',
      new AtomicCoreError(
        'IO_ERROR',
        'docker start failed.',
        'Bind for 127.0.0.1:41000 failed: port is already allocated'
      ),
      true,
    ],
    [
      'the kernel refusing the bind',
      new AtomicCoreError(
        'IO_ERROR',
        'docker start failed.',
        'listen tcp4 127.0.0.1:41000: bind: address already in use'
      ),
      true,
    ],
    [
      'some other docker failure',
      new AtomicCoreError('IO_ERROR', 'docker start failed.', 'no such image'),
      false,
    ],
    ['a plain Error', new Error('port is already allocated'), false],
  ])('%s → %s', (_case, error, expected) => {
    expect(isPortBindConflict(error)).toBe(expected)
  })
})

describe('readContainerState', () => {
  it.each([
    ['absent: gone counts as exited', { found: false, value: null }, { exited: true, exitCode: null }],
    [
      'running',
      { found: true, value: { State: { Running: true, Status: 'running' } } },
      { exited: false, exitCode: null },
    ],
    [
      'exited, with its code',
      { found: true, value: { State: { Running: false, Status: 'exited', ExitCode: 137 } } },
      { exited: true, exitCode: 137 },
    ],
    [
      'dead',
      { found: true, value: { State: { Running: false, Status: 'dead', ExitCode: 1 } } },
      { exited: true, exitCode: 1 },
    ],
    [
      'created, not started yet',
      { found: true, value: { State: { Running: false, Status: 'created' } } },
      { exited: false, exitCode: null },
    ],
    [
      'a shape it does not recognise is not read as an exit (the timeout still bounds the wait)',
      { found: true, value: {} },
      { exited: false, exitCode: null },
    ],
  ])('%s', (_case, inspected, expected) => {
    expect(readContainerState(inspected)).toEqual(expected)
  })
})

describe('stripDockerTimestamps', () => {
  it.each([
    [
      'drops the RFC3339Nano prefix `docker logs --timestamps` adds',
      '2026-09-28T10:00:00.123456789Z hello\n',
      'hello\n',
    ],
    ['keeps every line, in order', '2026-09-28T10:00:00.1Z a\n2026-09-28T10:00:01.2Z b\n', 'a\nb\n'],
    ['leaves a line with no timestamp alone', 'plain line\n', 'plain line\n'],
    ['keeps an empty log empty', '', ''],
  ])('%s', (_case, input, expected) => {
    expect(stripDockerTimestamps(input)).toBe(expected)
  })
})
