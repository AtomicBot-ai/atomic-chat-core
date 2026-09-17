import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startControlHarness as start } from '../../../../test/helpers/control-harness.js'
import type { ControlHarness } from '../../../../test/helpers/control-harness.js'

let h: ControlHarness

beforeEach(async () => {
  h = await start()
})
afterEach(() => h.server.close())

describe('settings routes', () => {
  const json = (path: string, method: string, body: unknown) =>
    h.get(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  it('reads a provider’s values with the revision and migration record', async () => {
    const res = await h.get('/atomic/v1/settings/llamacpp-upstream')
    const body = (await res.json()) as {
      provider: string
      revision: number
      values: Record<string, unknown>
      migration: unknown
    }

    expect(res.status).toBe(200)
    expect(body.provider).toBe('llamacpp-upstream')
    expect(body.values['ctx_size']).toBe(4096)
    expect(body.revision).toBe(7)
    expect(body.migration, 'never imported yet').toBeNull()
  })

  it('patches values and passes the expected revision through', async () => {
    const res = await json('/atomic/v1/settings/llamacpp-upstream', 'PATCH', {
      values: { ctx_size: 8192 },
      expected_revision: 7,
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ revision: 8, changed: ['ctx_size'] })
    expect(h.settings.calls).toContain('update llamacpp-upstream {"ctx_size":8192} expected=7')
  })

  it('treats omitted patch values and revision as an empty unconditional patch', async () => {
    const res = await json('/atomic/v1/settings/llamacpp-upstream', 'PATCH', {})

    expect(res.status).toBe(200)
    expect(h.settings.calls.at(-1)).toBe('update llamacpp-upstream {} expected=any')
  })

  it('imports the app’s settings and reports what it applied', async () => {
    const res = await json('/atomic/v1/settings/llamacpp-upstream/import', 'POST', {
      values: { ctx_size: 8192, n_gpu_layers: 20 },
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: 'imported', applied: ['ctx_size', 'n_gpu_layers'] })
  })

  it('answers 409 for a conflict, so the caller cannot mistake it for a migrated scope', async () => {
    h.settings.nextImport = {
      status: 'conflict',
      applied: [],
      conflicts: [{ key: 'ctx_size', base: 4096, core: 2048, legacy: 8192 }],
      revision: 7,
    }

    const res = await json('/atomic/v1/settings/llamacpp-upstream/import', 'POST', {
      values: { ctx_size: 8192 },
    })

    expect(res.status).toBe(409)
    expect((await res.json()) as { conflicts: unknown[] }).toMatchObject({
      status: 'conflict',
      conflicts: [{ key: 'ctx_size' }],
    })
  })

  it('forwards the caller’s conflict resolutions', async () => {
    await json('/atomic/v1/settings/llamacpp-upstream/import', 'POST', {
      values: { ctx_size: 8192 },
      resolutions: { ctx_size: 'core' },
    })

    expect(h.settings.calls.at(-1)).toContain('resolutions={"ctx_size":"core"}')
  })

  it('passes an import revision even when the legacy payload has no values', async () => {
    const res = await json('/atomic/v1/settings/llamacpp-upstream/import', 'POST', {
      expected_revision: 7,
    })

    expect(res.status).toBe(200)
    expect(h.settings.calls.at(-1)).toContain('import llamacpp-upstream {}')
    expect(h.settings.calls.at(-1)).toContain('expected=7')
  })

  it('records an acknowledgement and refuses one without a revision', async () => {
    const ok = await json('/atomic/v1/settings/llamacpp-upstream/acknowledge', 'POST', { revision: 8 })
    expect(ok.status).toBe(200)
    expect(h.settings.calls).toContain('acknowledge llamacpp-upstream 8')

    const bad = await json('/atomic/v1/settings/llamacpp-upstream/acknowledge', 'POST', {})
    expect(bad.status).toBe(400)
    expect((await bad.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'INVALID_ARGUMENT' },
    })
  })
})

describe('settings status', () => {
  it('reports a scope that has never been imported as not migrated', async () => {
    const body = (await (await h.get('/atomic/v1/settings/status')).json()) as {
      revision: number
      scopes: Record<string, { migrated: boolean; in_sync: boolean }>
    }

    expect(body.scopes['llamacpp-upstream']).toMatchObject({ migrated: false, in_sync: false })
  })

  it('reports a migrated scope, and whether the app has confirmed it saw the result', async () => {
    // The runtime flag must not be turned on for a scope that is not migrated: the core would load
    // with its own defaults instead of the user's.
    h.settings.migrations['llamacpp-upstream'] = {
      baseline: { ctx_size: 8192 },
      legacy_hash: 'abc',
      acknowledged_revision: 7,
    }

    const body = (await (await h.get('/atomic/v1/settings/status')).json()) as {
      scopes: Record<string, { migrated: boolean; in_sync: boolean; acknowledged_revision: number }>
    }

    expect(body.scopes['llamacpp-upstream']).toMatchObject({
      migrated: true,
      acknowledged_revision: 7,
      in_sync: true,
    })
  })

  it('reports a scope whose mirror has fallen behind as out of sync', async () => {
    h.settings.migrations['llamacpp-upstream'] = {
      baseline: {},
      legacy_hash: 'abc',
      acknowledged_revision: 3,
    }

    const body = (await (await h.get('/atomic/v1/settings/status')).json()) as {
      scopes: Record<string, { migrated: boolean; in_sync: boolean }>
    }

    expect(body.scopes['llamacpp-upstream']).toMatchObject({ migrated: true, in_sync: false })
  })
})
