/**
 * A report of what a machine can do, fit to hand to somebody else.
 *
 * The same probes the setup uses are run and their verdict attached, so a report says both "here is
 * the machine" and "here is what setup would make of it" — the second part is the one a bug report
 * actually needs, and it cannot drift from what the product would decide because it is the product's
 * own function deciding.
 *
 * Before it leaves the machine it is redacted. A probe report is full of the user: their account
 * name and SID, their home directory in every path, the machine's name, and each GPU's hardware UUID,
 * which identifies one physical card as surely as a serial number. None of that helps anyone read the
 * report, so it is replaced — consistently, so two mentions of the same card still read as one card.
 */

import {
  assessLinux,
  probeLinux,
  type LinuxAssessment,
  type LinuxAssessmentOptions,
  type LinuxFacts,
  type LinuxProbeDeps,
} from './linux-probe.js'
import {
  assessWindows,
  probeWindows,
  type WindowsAssessment,
  type WindowsAssessmentOptions,
  type WindowsFacts,
  type WindowsProbeDeps,
} from './windows-probe.js'

export type HostInventory =
  | {
      schema_version: 1
      platform: 'linux'
      collected_at: string
      facts: LinuxFacts
      assessment: LinuxAssessment
    }
  | {
      schema_version: 1
      platform: 'win32'
      collected_at: string
      facts: WindowsFacts
      assessment: WindowsAssessment
    }

export type InventoryRequest =
  | {
      platform: 'linux'
      deps: LinuxProbeDeps
      user: string
      options: LinuxAssessmentOptions
      now: () => Date
    }
  | {
      platform: 'win32'
      deps: WindowsProbeDeps
      options: WindowsAssessmentOptions
      now: () => Date
    }

/** Probe the machine and attach setup's verdict on it. Read-only, like the probes it runs. */
export async function collectInventory(request: InventoryRequest): Promise<HostInventory> {
  const collected_at = request.now().toISOString()
  if (request.platform === 'linux') {
    const facts = await probeLinux(request.deps, request.user)
    return {
      schema_version: 1,
      platform: 'linux',
      collected_at,
      facts,
      assessment: assessLinux(facts, request.options),
    }
  }
  const facts = await probeWindows(request.deps)
  return {
    schema_version: 1,
    platform: 'win32',
    collected_at,
    facts,
    assessment: assessWindows(facts, request.options),
  }
}

/** What is personal about this machine and must not appear in a report. */
export interface InventorySecrets {
  user?: string
  home?: string
  hostname?: string
  /** A Windows account's SID; it names the account as surely as the user name does. */
  sid?: string
}

const GPU_UUID = /\bGPU-[0-9a-fA-F][0-9a-fA-F-]{7,}\b/g

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The report with everything personal replaced. Longest secrets go first, so a home directory that
 * contains the user name is replaced whole rather than leaving `/home/<user>` half-redacted.
 */
export function redactInventory(inventory: HostInventory, secrets: InventorySecrets): HostInventory {
  const pairs: [string, string][] = [
    [secrets.home ?? '', '<home>'],
    [secrets.sid ?? '', '<sid>'],
    [secrets.hostname ?? '', '<host>'],
    [secrets.user ?? '', '<user>'],
  ]
  const replacements = pairs
    .filter(([secret]) => secret.trim().length > 0)
    .sort(([a], [b]) => b.length - a.length)
    .map(([secret, label]) => [new RegExp(escape(secret), 'gi'), label] as const)

  // The same card keeps the same label everywhere it appears, so the report still says "one card".
  const cards = new Map<string, string>()
  const card = (uuid: string): string => {
    const key = uuid.toLowerCase()
    let label = cards.get(key)
    if (label === undefined) {
      label = `GPU-<redacted-${cards.size + 1}>`
      cards.set(key, label)
    }
    return label
  }

  const scrub = (text: string): string => {
    let out = text.replace(GPU_UUID, card)
    for (const [pattern, label] of replacements) out = out.replace(pattern, label)
    return out
  }

  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return scrub(value)
    if (Array.isArray(value)) return value.map(walk)
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, walk(inner)]))
    }
    return value
  }

  return walk(inventory) as HostInventory
}
