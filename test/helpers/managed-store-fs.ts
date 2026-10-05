/**
 * An in-memory disk for the managed-runtime store. Exclusive create is the whole of the mutual
 * exclusion between an app core and a CLI core, so that part behaves exactly as the real one does.
 */

import type { StoreFs } from '../../src/runtime/environment/index.js'

/**
 * The fake keeps POSIX paths whatever the host: the store joins its paths with `node:path`, which
 * on a Windows runner gives `\\shared\\…` (and a drive for a resolved file URL), while the tests
 * seed and read `/shared/…`.
 */
export const posixPath = (path: string): string => path.replace(/^[A-Za-z]:(?=[\\/])/, '').replace(/\\/g, '/')

/** A map whose keys are POSIX paths however a caller spells them, so a test's own `files.get(join(…))` matches. */
class PosixPathMap<V> extends Map<string, V> {
  override get(key: string): V | undefined {
    return super.get(posixPath(key))
  }
  override set(key: string, value: V): this {
    return super.set(posixPath(key), value)
  }
  override has(key: string): boolean {
    return super.has(posixPath(key))
  }
  override delete(key: string): boolean {
    return super.delete(posixPath(key))
  }
}

export class FakeManagedFs implements StoreFs {
  files: Map<string, string> = new PosixPathMap<string>()
  mtimes: Map<string, number> = new PosixPathMap<number>()
  clock = 1_000
  /** Every rename, so a test can see how a write was staged. */
  renames: [string, string][] = []

  async readFile(path: string): Promise<string> {
    path = posixPath(path)
    const text = this.files.get(path)
    if (text === undefined) throw new Error(`ENOENT: ${path}`)
    return text
  }

  async writeFile(path: string, data: string): Promise<void> {
    path = posixPath(path)
    this.files.set(path, data)
    this.mtimes.set(path, this.clock)
  }

  async rename(from: string, to: string): Promise<void> {
    from = posixPath(from)
    to = posixPath(to)
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
    path = posixPath(path)
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
    path = posixPath(path)
    this.files.delete(path)
    this.mtimes.delete(path)
  }

  async stat(path: string): Promise<{ mtimeMs: number }> {
    path = posixPath(path)
    const mtime = this.mtimes.get(path)
    if (mtime === undefined) throw new Error(`ENOENT: ${path}`)
    return { mtimeMs: mtime }
  }

  async openExclusive(path: string): Promise<{ close(): Promise<void> }> {
    path = posixPath(path)
    if (this.files.has(path)) throw new Error(`EEXIST: ${path}`)
    this.files.set(path, 'held')
    this.mtimes.set(path, this.clock)
    return { close: async () => undefined }
  }
}
