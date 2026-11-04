import { createServer } from 'node:http'
import { once } from 'node:events'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, it } from 'vitest'

interface Profile {
  env: Record<string, string>
  dataFolder: string
}
interface Session {
  app: { browser: unknown }
  profile: Profile
}

// The app owns its isolated WebDriver driver and profile. Ordinary core CI needs no app checkout.
async function appHarness<T>(name: string): Promise<T> {
  const root = process.env['ATOMIC_APP_E2E_HARNESS'] ?? '../Atomic-Chat/tests/e2e/harness'
  return import(/* @vite-ignore */ pathToFileURL(resolve(root, name + '.ts')).href) as Promise<T>
}

it.skipIf(process.env['ATOMIC_APP_E2E'] !== '1')(
  'obeys the real desktop consent relay while preserving a failed model load on the wire',
  async () => {
    const { startSession, endSession } = await appHarness<{
      startSession(name: string, options: { prepare(profile: Profile): Promise<void> }): Promise<Session>
      endSession(session: Session | undefined): Promise<string[]>
    }>('session')
    const { invoke } = await appHarness<{
      invoke(browser: unknown, name: string, args: Record<string, unknown>): Promise<unknown>
    }>('app')
    const { coreRequest } = await appHarness<{
      coreRequest(folder: string, path: string, init?: RequestInit): Promise<Response>
    }>('core')
    const { installFakeBackend, writeFakeModel } = await appHarness<{
      installFakeBackend(profile: Profile, options: { mode: string }): Promise<void>
      writeFakeModel(profile: Profile, model: string): Promise<unknown>
    }>('fixtures')
    const envelopes: string[] = []
    const ingest = createServer(async (req, res) => {
      let body = ''
      for await (const chunk of req) body += String(chunk)
      envelopes.push(body)
      res.end('{}')
    })
    let session: Session | undefined
    try {
      ingest.listen(0, '127.0.0.1')
      await once(ingest, 'listening')
      const address = ingest.address()
      if (!address || typeof address === 'string') throw new Error('Expected a loopback ingest port')
      const dsn = `http://fixture@127.0.0.1:${address.port}/2`
      const model = 'desktop-consent-fixture'
      session = await startSession('core-consent-failed-load', {
        async prepare(profile) {
          profile.env['ATOMIC_CORE_SENTRY_DSN'] = dsn
          profile.env['ATOMIC_CORE_SENTRY_ENVIRONMENT'] = 'prerelease'
          await installFakeBackend(profile, { mode: 'exit-1' })
          await writeFakeModel(profile, model)
        },
      })
      const { app, profile } = session
      for (const enabled of [false, true]) {
        await invoke(app.browser, 'set_telemetry_consent', { enabled })
        await expect
          .poll(async () => (await coreRequest(profile.dataFolder, '/telemetry')).json(), {
            timeout: 10_000,
          })
          .toMatchObject({ enabled })
        const response = await coreRequest(profile.dataFolder, `/models/llamacpp-upstream/${model}/load`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
        expect(response.ok).toBe(false)
        const body = await response.json()
        expect(body).toMatchObject({ error: { code: 'LLAMA_CPP_PROCESS_ERROR' } })
        expect(body).not.toHaveProperty('error.diagnostic')
        expect(body).not.toHaveProperty('error.cause')
        if (enabled) {
          await expect.poll(() => envelopes.length, { timeout: 10_000 }).toBe(1)
          const event = JSON.parse(envelopes[0]!.trim().split('\n')[2]!)
          expect(event.tags).toMatchObject({ diagnostic_version: 'core-v1' })
          expect(envelopes[0]).not.toContain(model)
          expect(envelopes[0]).not.toContain(profile.dataFolder)
        } else {
          await delay(300)
          expect(envelopes).toHaveLength(0)
        }
      }
    } finally {
      ingest.closeAllConnections()
      await new Promise<void>((done) => ingest.close(() => done()))
      expect(await endSession(session)).toEqual([])
    }
  }
)
