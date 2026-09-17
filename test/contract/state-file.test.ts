/**
 * Replay of the `<data>/local-api-server.json` fixtures dumped from the app's `state_file.rs`
 * (PLAN.md §4, stage 4b). Writes go to a real file in a temporary folder and are compared by exact
 * bytes; the live pid is replaced by `<pid>` the way the dump replaced it.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadFixtureSet } from './fixtures.js'
import {
  markServerRunning,
  markServerStopped,
  readServerStateFile,
  serverApiUrl,
  serverBaseUrl,
} from '../../src/server/state-file.js'

type Input =
  | { op: 'mark_running'; host: string; port: number; prefix: string; requires_api_key: boolean }
  | { op: 'mark_stopped'; existing_file: string | null }
  | { op: 'read'; file: string | null }

let dir: string
let path: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atomic-state-file-'))
  path = join(dir, 'local-api-server.json')
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('state-file', () => {
  const { cases } = loadFixtureSet<Input, Record<string, unknown>>('state-file')

  it.each(cases.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    const input = c.input
    const { placeholders: _placeholders, ...expected } = c.expected
    switch (input.op) {
      case 'mark_running': {
        await markServerRunning(path, {
          host: input.host,
          port: input.port,
          prefix: input.prefix,
          requiresApiKey: input.requires_api_key,
        })
        const text = (await readFile(path, 'utf8')).replace(`"pid": ${process.pid}`, '"pid": "<pid>"')
        expect({ file: JSON.parse(text) as unknown, text }).toEqual(expected)
        return
      }
      case 'mark_stopped': {
        if (input.existing_file !== null) await writeFile(path, input.existing_file)
        await markServerStopped(path)
        const text = await readFile(path, 'utf8')
        expect({ file: JSON.parse(text) as unknown, text }).toEqual(expected)
        return
      }
      case 'read': {
        if (input.file !== null) await writeFile(path, input.file)
        const state = await readServerStateFile(path)
        expect({ state, base_url: serverBaseUrl(state), api_url: serverApiUrl(state) }).toEqual(expected)
        return
      }
    }
  })
})

describe('state-file writes are best-effort', () => {
  it('logs and carries on when the folder cannot be created', async () => {
    const blocker = join(dir, 'not-a-folder')
    await writeFile(blocker, '')
    const logged: string[] = []

    await markServerRunning(
      join(blocker, 'local-api-server.json'),
      { host: '127.0.0.1', port: 1337, prefix: '/v1', requiresApiKey: false },
      (m) => logged.push(m)
    )

    expect(logged).toHaveLength(1)
  })
})
