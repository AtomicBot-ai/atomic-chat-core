import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { loadAtomicModelCatalog, type AtomicSourceOverrides } from '../client/index.js'

/** Node entry for the server installer. Desktop supplies its readLocal relay to the browser-safe client. */
export function loadHostModelCatalog(
  env: AtomicSourceOverrides = process.env as AtomicSourceOverrides,
  fetchImpl: typeof fetch = fetch
) {
  return loadAtomicModelCatalog(env, {
    fetch: fetchImpl,
    readLocal: (url) => readFile(fileURLToPath(url), 'utf8'),
  })
}
