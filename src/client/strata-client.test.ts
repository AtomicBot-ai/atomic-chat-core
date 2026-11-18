import { expect, it } from 'vitest'
import { CoreClient } from './control-client.js'

it('uses the D4 Strata paths, encoded operation IDs and exact request bodies', async () => {
  const seen: unknown[] = []
  const client = new CoreClient({
    baseUrl: 'http://localhost:1337',
    token: 'control-key',
    fetch: async (url, init) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer control-key')
      seen.push([
        new URL(String(url)).pathname,
        init?.method ?? 'GET',
        init?.body ? JSON.parse(String(init.body)) : null,
      ])
      return Response.json({ operation_id: 'op', state: 'queued' })
    },
  })
  const preparation = {
    request_id: 'request',
    model_id: 'model',
    source_digest: 'a'.repeat(64),
    maintenance_id: 'guard',
  }
  const maintenance = {
    request_id: 'replace',
    model_id: 'model',
    action: 'replace' as const,
    target_source_digest: 'a'.repeat(64),
  }
  await client.checkStrataModel({ model_id: 'model' })
  expect(await client.beginStrataPreparation(preparation)).toMatchObject({ operation_id: 'op' })
  await client.strataPreparations()
  await client.strataPreparation('a/b')
  await client.cancelStrataPreparation('a/b')
  await client.resumeStrataPreparation('a/b')
  await client.beginStrataMaintenance(maintenance)
  await client.listStrataMaintenance()
  await client.strataMaintenance('a/b')
  await client.completeStrataMaintenance('a/b')
  const p = '/atomic/v1/strata/preparations',
    m = '/atomic/v1/models/strata/maintenance'
  expect(seen).toEqual([
    ['/atomic/v1/models/strata/check', 'POST', { model_id: 'model' }],
    [p, 'POST', preparation],
    [p, 'GET', null],
    [p + '/a%2Fb', 'GET', null],
    [p + '/a%2Fb/cancel', 'POST', {}],
    [p + '/a%2Fb/resume', 'POST', {}],
    [m, 'POST', maintenance],
    [m, 'GET', null],
    [m + '/a%2Fb', 'GET', null],
    [m + '/a%2Fb/complete', 'POST', {}],
  ])
})
