import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeTmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import { PRISM_MODEL_RULES_BASELINE } from './rules-baseline.js'
import {
  prismModelRulesCachePath,
  PrismModelRulesService,
  PRISM_MODEL_RULES_TTL_MS,
} from './rules-service.js'

const NEWER = { ...PRISM_MODEL_RULES_BASELINE, rules_version: PRISM_MODEL_RULES_BASELINE.rules_version + 1 }
const OLDER = { ...PRISM_MODEL_RULES_BASELINE, rules_version: 0 }

let data: TmpDataFolder
beforeEach(async () => {
  data = await makeTmpDataFolder('atomic-prism-rules-')
})
afterEach(() => data.cleanup())

const service = (respond: () => Response | Promise<Response>, clock = { now: 0 }) => {
  let calls = 0
  const svc = new PrismModelRulesService({
    layout: data.layout,
    fetch: (async () => {
      calls++
      return respond()
    }) as typeof fetch,
    now: () => clock.now,
  })
  return { svc, calls: () => calls, clock }
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

describe('prismModelRulesCachePath', () => {
  it('lives next to the Prism packs', () => {
    expect(prismModelRulesCachePath(data.layout)).toBe(
      join(data.layout.provider('atomic-prism').root, 'model-rules.cache.json')
    )
  })
})

describe('PrismModelRulesService', () => {
  it('takes a newer live document, caches it on disk and in memory', async () => {
    const { svc, calls, clock } = service(() => json(NEWER))
    expect((await svc.rules()).rules_version).toBe(NEWER.rules_version)
    expect(
      JSON.parse(await readFile(prismModelRulesCachePath(data.layout), 'utf8')).rules.rules_version
    ).toBe(NEWER.rules_version)
    await svc.rules()
    expect(calls()).toBe(1)
    clock.now += PRISM_MODEL_RULES_TTL_MS
    await svc.rules()
    expect(calls()).toBe(2)
  })

  it('keeps the baseline over an older live document', async () => {
    const { svc } = service(() => json(OLDER))
    expect(await svc.rules()).toBe(PRISM_MODEL_RULES_BASELINE)
  })

  it('falls back to disk, then to the baseline, when offline', async () => {
    const { svc } = service(() => Promise.reject(new Error('offline')))
    expect(await svc.rules()).toBe(PRISM_MODEL_RULES_BASELINE)
    await mkdir(data.layout.provider('atomic-prism').root, { recursive: true })
    await writeFile(prismModelRulesCachePath(data.layout), JSON.stringify({ fetched_at: 1, rules: NEWER }))
    expect((await svc.rules({ force: true })).rules_version).toBe(NEWER.rules_version)
  })

  it('reads only the caches for the load gate', async () => {
    const { svc, calls } = service(() => json(NEWER))
    expect(await svc.cachedRules()).toBe(PRISM_MODEL_RULES_BASELINE)
    expect(calls()).toBe(0)
    await svc.rules()
    expect((await svc.cachedRules()).rules_version).toBe(NEWER.rules_version)
  })
})
