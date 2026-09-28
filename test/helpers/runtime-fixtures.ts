/**
 * Runtime descriptor fixtures (`test/fixtures/runtimes/`): verbatim copies of published
 * `atomic-chat-conf/runtimes/*.json` documents, so the descriptor parser is tested against real
 * data instead of a hand-written stand-in.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export function readRuntimeFixture(name: string): unknown {
  const text = readFileSync(fileURLToPath(new URL(`../fixtures/runtimes/${name}`, import.meta.url)), 'utf8')
  return JSON.parse(text) as unknown
}
