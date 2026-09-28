/**
 * Recorded tool output for the hardware probe's parsers (`test/fixtures/hardware/`, see its README for
 * which machine each file came from and which ones are synthetic).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export function readHardwareFixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../fixtures/hardware/${name}`, import.meta.url)), 'utf8')
}
