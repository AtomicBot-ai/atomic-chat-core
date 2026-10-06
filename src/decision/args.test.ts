import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildDecisionArgs,
  buildUpstreamDecisionArgs,
  commandSummary,
  DECISION_ENV_PREFIX,
  decisionEnv,
  decisionThreads,
  MAX_AUTO_THREADS,
  resolveDataPath,
  withoutDecisionEnv,
} from './args.js'

describe('buildDecisionArgs', () => {
  it('emits the DECISION.md launch line, loopback only, no web UI', () => {
    expect(buildDecisionArgs({ modelPath: '/m/laya.gguf', threads: 4, port: 3456 })).toEqual([
      '--decision',
      '-m',
      '/m/laya.gguf',
      '--device',
      'none',
      '-t',
      '4',
      '--host',
      '127.0.0.1',
      '--port',
      '3456',
      '--no-webui',
    ])
  })

  it('adds the spec, the alias and the uncalibrated router only when asked', () => {
    const argv = buildDecisionArgs({
      modelPath: '/m/laya.gguf',
      specPath: '/m/calibration.json',
      modelId: 'atomic/router-laya',
      threads: 2,
      port: 1,
      allowUncalibrated: true,
    })
    expect(argv.slice(0, 7)).toEqual([
      '--decision',
      '-m',
      '/m/laya.gguf',
      '--decision-spec',
      '/m/calibration.json',
      '-a',
      'atomic/router-laya',
    ])
    expect(argv.at(-1)).toBe('--decision-allow-uncalibrated')
  })

  it('names the conversion cache and type for a checkpoint folder, in argv', () => {
    const argv = buildDecisionArgs({
      modelPath: '/data/decision/models/laya-multilingual',
      modelId: 'laya-multilingual',
      convert: { cacheDir: '/data/decision/gguf-cache', type: 'f16' },
      threads: 4,
      port: 1,
    })
    expect(argv.slice(0, 9)).toEqual([
      '--decision',
      '-m',
      '/data/decision/models/laya-multilingual',
      '-a',
      'laya-multilingual',
      '--decision-convert-cache',
      '/data/decision/gguf-cache',
      '--decision-convert-type',
      'f16',
    ])
    expect(buildDecisionArgs({ modelPath: '/m/laya.gguf', threads: 1, port: 1 })).not.toContain(
      '--decision-convert-cache'
    )
  })

  it('never carries a chat or embedding flag, and never the key', () => {
    const argv = buildDecisionArgs({ modelPath: 'm', threads: 1, port: 1, specPath: '', modelId: '' })
    for (const flag of ['--embedding', '--pooling', '--api-key', '-c', '--ctx-size', '-ngl', '--jinja', '-a'])
      expect(argv).not.toContain(flag)
  })
})

describe('decisionEnv', () => {
  it('passes the key in LLAMA_API_KEY', () => {
    expect(decisionEnv('secret')).toEqual({ LLAMA_API_KEY: 'secret' })
  })
})

describe('withoutDecisionEnv', () => {
  it('drops every LLAMA_ARG_DECISION_* variable, whatever its case, and keeps the rest', () => {
    const env = {
      PATH: '/usr/bin',
      [`${DECISION_ENV_PREFIX}DEBUG`]: '1',
      LLAMA_ARG_DECISION_QUEUE: '64',
      llama_arg_decision_plan: 'packed',
      LLAMA_ARG_THREADS: '4',
      LLAMA_DECISION_DEBUG_JOB_DELAY_MS: '10',
    }
    expect(withoutDecisionEnv(env)).toEqual({
      PATH: '/usr/bin',
      LLAMA_ARG_THREADS: '4',
      LLAMA_DECISION_DEBUG_JOB_DELAY_MS: '10',
    })
    expect(env).toHaveProperty('LLAMA_ARG_DECISION_QUEUE')
  })
})

describe('decisionThreads', () => {
  it.each([
    [{ setting: 6, physicalCores: 16 }, 6],
    [{ setting: 32, physicalCores: 4 }, 32],
    [{ setting: 0, physicalCores: 4 }, 4],
    [{ setting: 0, physicalCores: 24 }, MAX_AUTO_THREADS],
    [{ setting: 0, physicalCores: 8, hybrid: true }, 4],
    [{ setting: 0, physicalCores: 14, hybrid: true }, 7],
    [{ setting: 0, physicalCores: 12, performanceCores: 4, hybrid: true }, 4],
    [{ setting: 0, physicalCores: 0 }, 1],
    [{ setting: -2, physicalCores: 3 }, 3],
    [{ setting: 1.5, physicalCores: 3 }, 3],
  ])('%j → %i', (facts, threads) => {
    expect(decisionThreads(facts)).toBe(threads)
  })
})

describe('resolveDataPath', () => {
  it('keeps absolute paths, resolves relative ones against the data folder, and reads empty as none', () => {
    expect(resolveDataPath('/data', '/models/laya.gguf')).toBe('/models/laya.gguf')
    expect(resolveDataPath('/data', 'C:\\models\\laya.gguf')).toBe('C:\\models\\laya.gguf')
    expect(resolveDataPath('/data', 'decision/laya.gguf')).toBe(join('/data', 'decision/laya.gguf'))
    expect(resolveDataPath('/data', '  ')).toBeUndefined()
  })
})

describe('commandSummary', () => {
  it('quotes parts with spaces', () => {
    expect(commandSummary('/b/llama-server', ['-m', '/My Models/x.gguf'])).toBe(
      '/b/llama-server -m "/My Models/x.gguf"'
    )
  })
})

describe('buildUpstreamDecisionArgs', () => {
  it('starts stock llama.cpp without a decision flag, the whole prompt in one batch', () => {
    expect(
      buildUpstreamDecisionArgs(
        { modelPath: '/m/lev.gguf', modelId: 'lev', threads: 6, port: 4567 },
        { ctxSize: 8192, wholePromptUbatch: false }
      )
    ).toEqual([
      '-m',
      '/m/lev.gguf',
      '-a',
      'lev',
      '-c',
      '8192',
      '-b',
      '8192',
      '-t',
      '6',
      '--host',
      '127.0.0.1',
      '--port',
      '4567',
      '--no-webui',
    ])
  })

  it('adds the projector, and the ubatch for a type read from the embeddings', () => {
    const argv = buildUpstreamDecisionArgs(
      { modelPath: '/m/clef.gguf', threads: 4, port: 1 },
      { mmprojPath: '/m/mmproj.gguf', ctxSize: 4096, wholePromptUbatch: true }
    )
    expect(argv.slice(0, 10)).toEqual([
      '-m',
      '/m/clef.gguf',
      '--mmproj',
      '/m/mmproj.gguf',
      '-c',
      '4096',
      '-b',
      '4096',
      '-ub',
      '4096',
    ])
    expect(argv).not.toContain('--decision')
    expect(argv).not.toContain('--device')
  })
})
