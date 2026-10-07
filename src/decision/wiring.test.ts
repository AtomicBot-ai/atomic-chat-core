import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CoreEvents, HardwareInfoResponse } from '../contracts/index.js'
import type { ChildProcessRecord } from '../lock/index.js'
import { SettingsStore } from '../settings/index.js'
import { fakeDecisionSpawn } from '../../test/helpers/fake-llama-server.js'
import { makeTmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import type { DecisionService } from './service.js'
import { createDecisionHttp, DecisionTimeoutError } from './http.js'
import type { DecisionHttp } from './http.js'
import { cpuFactsOf, decisionJournal, noticeEngineInstall, wireDecision } from './wiring.js'

let data: TmpDataFolder
const services: DecisionService[] = []

beforeEach(async () => {
  data = await makeTmpDataFolder()
})
afterEach(async () => {
  for (const s of services.splice(0)) await s.shutdown()
  await data.cleanup()
})

function fakeJournal() {
  const records: ChildProcessRecord[] = []
  const removed: number[] = []
  return {
    records,
    removed,
    add: async (record: ChildProcessRecord) => void records.push(record),
    remove: async (pid: number) => void removed.push(pid),
  }
}

const hardware = (os: 'macos' | 'linux', arch: string, cores: number): HardwareInfoResponse =>
  ({
    info: {
      cpu: { name: 'x', core_count: cores, arch, extensions: [], extensions_known: true },
      os_type: os,
    },
  }) as unknown as HardwareInfoResponse

describe('decisionJournal', () => {
  it('journals the process under the decision provider, with its start identity', async () => {
    const journal = fakeJournal()
    const adapter = decisionJournal(journal, 'instance-1', () => 1_700_000_000_000)
    await adapter.add(process.pid, 4242, '/packs/llama-server', 'atomic/router-laya')
    expect(journal.records).toEqual([
      {
        instance_id: 'instance-1',
        pid: process.pid,
        process_start_id: expect.any(String),
        exe: '/packs/llama-server',
        provider: 'decision',
        model_id: 'atomic/router-laya',
        port: 4242,
        started_at: '2023-11-14T22:13:20.000Z',
      },
    ])
    await adapter.remove(process.pid)
    expect(journal.removed).toEqual([process.pid])
  })
})

describe('cpuFactsOf', () => {
  it('marks Apple silicon as hybrid and nothing else', () => {
    expect(cpuFactsOf(hardware('macos', 'aarch64', 10))).toEqual({ physicalCores: 10, hybrid: true })
    expect(cpuFactsOf(hardware('macos', 'x86_64', 6))).toEqual({ physicalCores: 6 })
    expect(cpuFactsOf(hardware('linux', 'aarch64', 8))).toEqual({ physicalCores: 8 })
    expect(cpuFactsOf(undefined)).toEqual({ physicalCores: 1 })
  })
})

describe('noticeEngineInstall', () => {
  it('retries on a finished TurboQuant or llama.cpp install, naming it, and swallows a failed retry', async () => {
    const calls: Array<string | undefined> = []
    const service = {
      onEnginesChanged: async (provider?: string) => {
        calls.push(provider)
        throw new Error('settings unreadable')
      },
    } as unknown as Pick<DecisionService, 'onEnginesChanged'>
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => void unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)
    try {
      noticeEngineInstall(service, 'atomic-prism', true)
      noticeEngineInstall(service, 'llamacpp', false)
      expect(calls).toEqual([])
      noticeEngineInstall(service, 'llamacpp', true)
      noticeEngineInstall(service, 'llamacpp-upstream', true)
      expect(calls).toEqual(['llamacpp', 'llamacpp-upstream'])
      await new Promise((r) => setTimeout(r, 20))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})

describe('wireDecision', () => {
  it('runs the configured model on the installed fork build and journals it for its whole life', async () => {
    const settings = await SettingsStore.open(data.layout.core.settings)
    const model = join(data.root, 'router.gguf')
    await writeFile(model, 'GGUF')
    const exe = await data.writeBackend('llamacpp', 'b10269-1.7.0', 'macos-arm64')
    const journal = fakeJournal()
    const events: string[] = []
    const service = wireDecision({
      layout: data.layout,
      settings,
      journal,
      instanceId: 'instance-1',
      emit: (name) => void events.push(name),
      log: () => {},
      hardware: { info: async () => hardware('macos', 'aarch64', 8) },
      platform: process.platform,
      overrides: { probe: async () => true, spawn: fakeDecisionSpawn() },
    })
    services.push(service)
    expect(service.getStatus().state).toBe('disabled')
    const status = await service.configure({
      enabled: true,
      model_path: 'router.gguf',
      model_id: 'atomic/router-laya',
    })
    expect(status.enabled).toBe(true)
    const ready = await service.load()
    expect(ready).toMatchObject({
      state: 'ready',
      model_path: model,
      engine: { path: exe, version_backend: 'b10269-1.7.0/macos-arm64', version_gate: true },
      props: { model_id: 'atomic/router-laya' },
    })
    expect(settings.decision).toMatchObject({ enabled: true, model_path: 'router.gguf' })
    expect(journal.records).toMatchObject([
      { provider: 'decision', pid: ready.pid, model_id: 'atomic/router-laya' },
    ])
    await service.unload()
    for (let i = 0; i < 500 && journal.removed.length === 0; i++) await new Promise((r) => setTimeout(r, 10))
    expect(journal.removed).toContain(ready.pid)
    expect(events).toContain('decision:state')
  })

  it('tries an unsupported module again when a TurboQuant build finishes installing', async () => {
    const settings = await SettingsStore.open(data.layout.core.settings)
    await writeFile(join(data.root, 'router.gguf'), 'GGUF')
    const old = await data.writeBackend('llamacpp', 'b10000-1.6.0', 'macos-arm64')
    const listeners: Array<(event: CoreEvents['backend:download-finished']) => void> = []
    const probed: string[] = []
    const states: string[] = []
    const service = wireDecision({
      layout: data.layout,
      settings,
      journal: fakeJournal(),
      instanceId: 'instance-1',
      emit: (name, payload) => {
        if (name === 'decision:state') states.push((payload as CoreEvents['decision:state']).state)
      },
      on: (_name, listener) => {
        listeners.push(listener)
        return () => {}
      },
      log: () => {},
      platform: process.platform,
      // Only the new pack serves --decision.
      overrides: {
        probe: async (exe) => {
          probed.push(exe)
          return exe !== old
        },
        spawn: fakeDecisionSpawn(),
      },
    })
    services.push(service)
    await service.configure({ enabled: true, model_path: 'router.gguf' })
    for (let i = 0; i < 500 && service.getStatus().state !== 'unsupported'; i++)
      await new Promise((r) => setTimeout(r, 10))
    expect(service.getStatus().state).toBe('unsupported')
    expect(listeners).toHaveLength(1)
    const settled = { states: states.length, probed: probed.length }
    // Another provider, or a failed install, changes nothing: no start (no state event), no scan.
    listeners[0]!({ provider: 'llamacpp-upstream', backend: 'macos-arm64', success: true })
    listeners[0]!({ provider: 'llamacpp', backend: 'macos-arm64', success: false, error: 'x' })
    await new Promise((r) => setTimeout(r, 50))
    expect(service.getStatus().state).toBe('unsupported')
    expect({ states: states.length, probed: probed.length }).toEqual(settled)
    // Written after the negative checks, so only the real install below can find it.
    const exe = await data.writeBackend('llamacpp', 'b10269-1.7.0', 'macos-arm64')
    listeners[0]!({ provider: 'llamacpp', backend: 'macos-arm64', version: 'b10269-1.7.0', success: true })
    for (let i = 0; i < 500 && service.getStatus().state !== 'ready'; i++)
      await new Promise((r) => setTimeout(r, 10))
    expect(service.getStatus()).toMatchObject({ state: 'ready', engine: { path: exe } })
    expect(probed).toContain(exe)
  })

  it('skips a build whose readiness refuses the decision API and runs the next one', async () => {
    const settings = await SettingsStore.open(data.layout.core.settings)
    await writeFile(join(data.root, 'router.gguf'), 'GGUF')
    const newer = await data.writeBackend('llamacpp', 'b10400-1.8.0', 'macos-arm64')
    const valid = await data.writeBackend('llamacpp', 'b10269-1.7.0', 'macos-arm64')
    const spawned: string[] = []
    const service = wireDecision({
      layout: data.layout,
      settings,
      journal: fakeJournal(),
      instanceId: 'instance-1',
      emit: () => {},
      log: () => {},
      platform: process.platform,
      overrides: {
        probe: async () => true,
        // The newer build answers decision API version 2.
        spawn: (spec, onLine) => {
          spawned.push(spec.exe)
          return fakeDecisionSpawn(spec.exe === newer ? { decision: { apiVersion: 2 } } : {})(spec, onLine)
        },
      },
    })
    services.push(service)
    await service.configure({ enabled: true, model_path: 'router.gguf' })
    const ready = await service.load()
    expect(ready).toMatchObject({ state: 'ready', engine: { path: valid } })
    expect(spawned).toEqual([newer, valid])
    // Remembered: a start a call triggers goes straight to the valid build.
    await service.unload()
    expect(await service.decide('s', {})).toMatchObject({ reason: 'starting' })
    for (let i = 0; i < 500 && service.getStatus().state !== 'ready'; i++)
      await new Promise((r) => setTimeout(r, 10))
    expect(spawned).toEqual([newer, valid, valid])
    // An explicit load is a real second try: the refused build is started again.
    await service.unload()
    expect(await service.load()).toMatchObject({ state: 'ready', engine: { path: valid } })
    expect(spawned).toEqual([newer, valid, valid, newer, valid])
  })

  it('says the builds were refused at readiness when none is left, instead of asking for 1.7.0', async () => {
    const settings = await SettingsStore.open(data.layout.core.settings)
    await writeFile(join(data.root, 'router.gguf'), 'GGUF')
    await data.writeBackend('llamacpp', 'b10400-1.8.0', 'macos-arm64')
    const service = wireDecision({
      layout: data.layout,
      settings,
      journal: fakeJournal(),
      instanceId: 'instance-1',
      emit: () => {},
      log: () => {},
      platform: process.platform,
      overrides: { probe: async () => true, spawn: fakeDecisionSpawn({ decision: { apiVersion: 2 } }) },
    })
    services.push(service)
    await settings.updateDecision({ enabled: true, model_path: 'router.gguf' })
    await expect(service.load()).rejects.toMatchObject({
      code: 'DECISION_ENGINE_UNSUPPORTED',
      message: expect.stringContaining('refused at readiness'),
      details: expect.stringContaining('api_version 2'),
    })
    expect(service.getStatus()).toMatchObject({
      state: 'unsupported',
      error: { message: expect.not.stringContaining('Install TurboQuant') },
    })
  })

  it('waits through a slow /props and a busy /v1/models instead of refusing the build', async () => {
    const settings = await SettingsStore.open(data.layout.core.settings)
    await writeFile(join(data.root, 'router.gguf'), 'GGUF')
    const exe = await data.writeBackend('llamacpp', 'b10269-1.7.0', 'macos-arm64')
    const real = createDecisionHttp()
    let slowProps = 2
    let busyModels = 1
    const http: DecisionHttp = {
      request: async (url, init) => {
        const path = new URL(url).pathname
        if (path === '/v1/models' && busyModels > 0) {
          busyModels--
          return { status: 503, text: '' }
        }
        if (path === '/props' && slowProps > 0) {
          slowProps--
          throw new DecisionTimeoutError(init.timeoutMs)
        }
        return real.request(url, init)
      },
    }
    const spawned: string[] = []
    const service = wireDecision({
      layout: data.layout,
      settings,
      journal: fakeJournal(),
      instanceId: 'instance-1',
      emit: () => {},
      log: () => {},
      platform: process.platform,
      overrides: {
        http,
        probe: async () => true,
        spawn: (spec, onLine) => {
          spawned.push(spec.exe)
          return fakeDecisionSpawn()(spec, onLine)
        },
      },
    })
    services.push(service)
    await settings.updateDecision({ enabled: true, model_path: 'router.gguf' })
    expect(await service.load()).toMatchObject({ state: 'ready', engine: { path: exe } })
    // One process, never refused: the slow answers were "still loading".
    expect(spawned).toEqual([exe])
    expect(slowProps).toBe(0)
  })
})
