import { describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../contracts/index.js'
import { classifyFailure, diagnosticTags, errorChain } from '../telemetry/diagnostics.js'
import { SettingsStore, type SettingsFs } from './store.js'

const PATH = '/data/atomic-core/settings.json'

/** In-memory `node:fs/promises` subset whose rename can fail with a real errno code. */
class FakeFs implements SettingsFs {
  readonly files = new Map<string, string>()
  renameError: Error | undefined

  async readFile(path: string): Promise<string> {
    const text = this.files.get(path)
    if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
    return text
  }
  async writeFile(path: string, data: string): Promise<void> {
    this.files.set(path, data)
  }
  async rename(from: string, to: string): Promise<void> {
    if (this.renameError) throw this.renameError
    const text = this.files.get(from)
    if (text === undefined) throw Object.assign(new Error(`ENOENT: ${from}`), { code: 'ENOENT' })
    this.files.delete(from)
    this.files.set(to, text)
  }
  async mkdir(): Promise<string | undefined> {
    return undefined
  }
  async stat(path: string): Promise<unknown> {
    if (!this.files.has(path)) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
    return {}
  }
}

describe('SettingsStore.persist failure', () => {
  it('keeps the filesystem error behind a failed settings write', async () => {
    const fs = new FakeFs()
    const store = await SettingsStore.open(PATH, { fs, now: () => Date.UTC(2026, 10, 20) })
    // Windows commonly reports EPERM/EACCES when another process holds the target file open.
    const locked = Object.assign(new Error('EPERM: operation not permitted, rename settings.json.tmp'), {
      code: 'EPERM',
    })
    fs.renameError = locked

    const failure = await store.update('llamacpp', { mlock: true }).then(
      () => undefined,
      (error: unknown) => error
    )
    expect(failure).toBeInstanceOf(AtomicCoreError)
    const error = failure as AtomicCoreError
    expect(error.code).toBe('IO_ERROR')
    // The HTTP body stays exactly as before: the cause is internal-only.
    expect(error.toJSON()).toEqual({ code: 'IO_ERROR', message: error.message })
    expect(errorChain(error)).toEqual([error, locked])

    const diagnostic = classifyFailure(error, { component: 'http', operation: 'request' })
    expect(diagnostic).toMatchObject({ category: 'operational', reason: 'disk_permission' })
    expect(diagnosticTags(error, diagnostic)).toMatchObject({ cause_code: 'EPERM' })
  })
})
