/**
 * An in-memory disk for the managed-runtime store. Exclusive create is the whole of the mutual
 * exclusion between an app core and a CLI core, so that part behaves exactly as the real one does.
 */

import type { StoreFs } from '../../src/runtime/environment/index.js'

export class FakeManagedFs implements StoreFs {
  files = new Map<string, string>()
  mtimes = new Map<string, number>()
  clock = 1_000
  /** Every rename, so a test can see how a write was staged. */
  renames: [string, string][] = []

  async readFile(path: string): Promise<string> {
    const text = this.files.get(path)
    if (text === undefined) throw new Error(`ENOENT: ${path}`)
    return text
  }

  async writeFile(path: string, data: string): Promise<void> {
    this.files.set(path, data)
    this.mtimes.set(path, this.clock)
  }

  async rename(from: string, to: string): Promise<void> {
    const text = this.files.get(from)
    if (text === undefined) throw new Error(`ENOENT: ${from}`)
    this.files.set(to, text)
    this.mtimes.set(to, this.mtimes.get(from) ?? this.clock)
    this.files.delete(from)
    this.mtimes.delete(from)
    this.renames.push([from, to])
  }

  async mkdir(): Promise<string | undefined> {
    return undefined
  }

  async readdir(path: string): Promise<string[]> {
    const prefix = `${path}/`
    const names = new Set<string>()
    for (const file of this.files.keys()) {
      if (file.startsWith(prefix)) names.add(file.slice(prefix.length))
    }
    if (names.size === 0 && ![...this.files.keys()].some((file) => file.startsWith(path))) {
      throw new Error(`ENOENT: ${path}`)
    }
    return [...names]
  }

  async rm(path: string): Promise<void> {
    this.files.delete(path)
    this.mtimes.delete(path)
  }

  async stat(path: string): Promise<{ mtimeMs: number }> {
    const mtime = this.mtimes.get(path)
    if (mtime === undefined) throw new Error(`ENOENT: ${path}`)
    return { mtimeMs: mtime }
  }

  async openExclusive(path: string): Promise<{ close(): Promise<void> }> {
    if (this.files.has(path)) throw new Error(`EEXIST: ${path}`)
    this.files.set(path, 'held')
    this.mtimes.set(path, this.clock)
    return { close: async () => undefined }
  }
}
