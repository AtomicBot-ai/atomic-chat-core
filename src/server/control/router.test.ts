import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ControlSnapshot, SessionSummary } from './types.js'
import { session, startControlHarness as start } from '../../../test/helpers/control-harness.js'
import type { ControlHarness } from '../../../test/helpers/control-harness.js'

let h: ControlHarness

beforeEach(async () => {
  h = await start()
})
afterEach(() => h.server.close())

describe('health, snapshot and sessions', () => {
  it('returns sessions, server state, clients and a cursor in one snapshot', async () => {
    h.sessions.push(session({ model_id: 'loaded' }))
    h.emitter.emit('server:stopped', {})
    const snapshot = (await (await h.get('/atomic/v1/snapshot')).json()) as ControlSnapshot
    expect(snapshot.sessions).toHaveLength(1)
    expect(snapshot.sessions[0]).toMatchObject({ model_id: 'loaded', provider: 'llamacpp-upstream' })
    expect(snapshot.server.running).toBe(false)
    expect(snapshot.cursor).toBe('instance-under-test:1')
    expect(snapshot.instance_id).toBe('instance-under-test')
    const sessions = (await (await h.get('/atomic/v1/sessions')).json()) as { sessions: SessionSummary[] }
    expect(sessions.sessions).toHaveLength(1)
  })

  it('captures optimal state and cursor in the same snapshot', async () => {
    h.backends.optimalSnapshot = () => ({ 'llamacpp-upstream': { revision: 7, optimal: null } })
    h.emitter.emit('backend:optimal-changed', { provider: 'llamacpp-upstream', revision: 7, optimal: null })
    const snapshot = (await (await h.get('/atomic/v1/snapshot')).json()) as ControlSnapshot
    expect(snapshot.optimal_backends['llamacpp-upstream']).toEqual({ revision: 7, optimal: null })
    expect(snapshot.cursor).toBe(h.emitter.cursor())
  })
})
