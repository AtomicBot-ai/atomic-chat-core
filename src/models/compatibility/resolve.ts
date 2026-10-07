/**
 * The compatibility verdict for one GGUF file, pure: conf rules + header evidence + what PrismML
 * build is installed → which engine the file needs and whether it can run now.
 *
 * Evidence order: a conf rule for this exact file wins (it knows `excluded` masters and the
 * `min_prism_build`); otherwise the header decides (tensor type ids, `prism.*` metadata, and the
 * bits per weight that tell Q2_0 group-64 from the legacy group-128 layout); with neither the answer
 * is `inspection_required`. A file needing nothing beyond `upstream_capabilities` is `compatible`
 * with `provider: null` — the caller's routing is kept. There is no fallback from a Prism-only file
 * to stock llama.cpp.
 */

import type { CompatibilityVerdict, EngineCapability, LocalProviderId } from '../../contracts/index.js'
import type { GgufTensorSummary } from '../gguf/index.js'
import type { PrismModelRules, RuleMatch } from './rules.js'

/** Q2_0 group-64 stores 2.25 bits per weight, the legacy group-128 layout 2.125; split halfway. */
export const Q2_0_G64_MIN_BITS_PER_WEIGHT = 2.1875
/** Ids below this are stock ggml types every llama.cpp build knows (F32 … MXFP4). */
export const FIRST_NON_STOCK_GGML_TYPE = 41

export interface GgufEvidence {
  tensorTypes: Array<{ type: number; bitsPerWeight: number | null }>
  metadataKeys: string[]
}

export function evidenceFromSummary(summary: GgufTensorSummary): GgufEvidence {
  return {
    tensorTypes: summary.types.map((t) => ({ type: t.type, bitsPerWeight: t.bitsPerWeight })),
    metadataKeys: Object.keys(summary.metadata),
  }
}

export interface EvidenceCapabilities {
  capabilities: EngineCapability[]
  /** A Q2_0 tensor in the legacy group-128 layout. */
  legacy: boolean
  /** A Q2_0 tensor whose size could not be measured. */
  undetermined: boolean
  /** Type ids neither stock ggml nor the rules know. */
  unknownTypes: number[]
}

/** Header evidence → capabilities, by the rules' tables. */
export function capabilitiesFromEvidence(
  rules: PrismModelRules,
  evidence: GgufEvidence
): EvidenceCapabilities {
  const caps = new Set<EngineCapability>()
  let legacy = false
  let undetermined = false
  const unknownTypes: number[] = []
  for (const { type, bitsPerWeight } of evidence.tensorTypes) {
    const rule = rules.tensor_types[String(type)]
    if (rule === undefined) {
      if (type >= FIRST_NON_STOCK_GGML_TYPE) unknownTypes.push(type)
      continue
    }
    if (rule !== 'q2_0') {
      caps.add(rule)
      continue
    }
    if (bitsPerWeight === null) undetermined = true
    else if (bitsPerWeight >= Q2_0_G64_MIN_BITS_PER_WEIGHT) caps.add('q2_0_g64')
    else legacy = true
  }
  for (const [key, cap] of Object.entries(rules.metadata_capabilities)) {
    const prefix = key.slice(0, key.lastIndexOf('.') + 1)
    if (
      evidence.metadataKeys.includes(key) ||
      (prefix && evidence.metadataKeys.some((k) => k.startsWith(prefix)))
    ) {
      caps.add(cap)
    }
  }
  return {
    capabilities: [...caps].sort(),
    legacy,
    undetermined,
    unknownTypes: unknownTypes.sort((a, b) => a - b),
  }
}

export interface InstalledPrism {
  /** Build number of the PrismML pack in use, `null` when none is installed. */
  build: number | null
  /** What that release declares it runs; absent = unknown (only the build is compared). */
  capabilities?: readonly EngineCapability[]
}

export interface ResolveInput {
  rules: PrismModelRules
  rule?: RuleMatch
  evidence?: GgufEvidence
  prism: InstalledPrism
}

/** The verdict; see the module comment for the order of evidence. */
export function resolveCompatibility(input: ResolveInput): CompatibilityVerdict {
  const { rules, rule, evidence, prism } = input
  const base = { rules_version: rules.rules_version, installed_prism_build: prism.build }
  const family = rule ? { family: rule.family.id } : {}

  if (rule) {
    const { file } = rule
    switch (file.treatment) {
      case 'excluded':
        return {
          ...base,
          ...family,
          outcome: 'unsupported',
          provider: null,
          requires: file.requires,
          evidence: 'rules',
          reason: file.summary ?? `${file.file} is not offered`,
        }
      case 'legacy':
        return {
          ...base,
          ...family,
          outcome: 'legacy_artifact',
          provider: null,
          requires: [],
          evidence: 'rules',
          ...(file.replacement ? { replacement: file.replacement } : {}),
          reason: file.summary ?? `${file.file} uses a layout no current engine runs`,
        }
      case 'any':
        return {
          ...base,
          ...family,
          outcome: 'compatible',
          provider: null,
          requires: [],
          evidence: 'rules',
          reason: `${file.file} runs on stock llama.cpp`,
        }
      case 'prism_required':
        return prismVerdict(rules, prism, file.requires, 'rules', file.min_prism_build, family)
    }
  }

  if (!evidence) {
    return {
      ...base,
      outcome: 'inspection_required',
      provider: null,
      requires: [],
      evidence: 'none',
      reason: 'no rule matches this file; its header has not been read',
    }
  }
  const found = capabilitiesFromEvidence(rules, evidence)
  if (found.legacy) {
    return {
      ...base,
      outcome: 'legacy_artifact',
      provider: null,
      requires: [],
      evidence: 'header',
      reason: 'Q2_0 tensors in the legacy group-128 layout',
    }
  }
  if (found.unknownTypes.length > 0) {
    return {
      ...base,
      outcome: 'unsupported',
      provider: null,
      requires: found.capabilities,
      evidence: 'header',
      reason: `unknown ggml tensor types ${found.unknownTypes.join(', ')}`,
    }
  }
  if (found.undetermined) {
    return {
      ...base,
      outcome: 'inspection_required',
      provider: null,
      requires: [],
      evidence: 'header',
      reason: 'Q2_0 tensors whose layout could not be measured',
    }
  }
  const beyondUpstream = found.capabilities.filter((c) => !rules.upstream_capabilities.includes(c))
  if (beyondUpstream.length === 0) {
    return {
      ...base,
      outcome: 'compatible',
      provider: null,
      requires: [],
      evidence: 'header',
      reason: 'stock llama.cpp runs every tensor type in this file',
    }
  }
  return prismVerdict(rules, prism, beyondUpstream, 'header', undefined, {})
}

function prismVerdict(
  rules: PrismModelRules,
  prism: InstalledPrism,
  requires: EngineCapability[],
  evidence: 'rules' | 'header',
  minBuild: number | undefined,
  family: { family?: string }
): CompatibilityVerdict {
  const provider: LocalProviderId = 'atomic-prism'
  const base = {
    rules_version: rules.rules_version,
    installed_prism_build: prism.build,
    provider,
    requires: [...requires].sort(),
    evidence,
    ...(minBuild !== undefined ? { min_prism_build: minBuild } : {}),
    ...family,
  }
  if (prism.build === null) {
    return { ...base, outcome: 'engine_required', reason: `needs PrismML llama.cpp (${requires.join(', ')})` }
  }
  if (minBuild !== undefined && prism.build < minBuild) {
    return {
      ...base,
      outcome: 'engine_update_required',
      reason: `needs PrismML build ${minBuild} or newer, ${prism.build} is installed`,
    }
  }
  const missing = prism.capabilities ? requires.filter((c) => !prism.capabilities?.includes(c)) : []
  if (missing.length > 0) {
    return {
      ...base,
      outcome: 'engine_update_required',
      reason: `the installed PrismML build lacks ${missing.join(', ')}`,
    }
  }
  return { ...base, outcome: 'compatible', reason: `runs on PrismML build ${prism.build}` }
}

/**
 * What the load gate does with a verdict for `provider`: `null` lets the load go on; otherwise the
 * error code and a message. `inspection_required` never blocks — the gate only refuses on evidence.
 */
export function gateDecision(
  verdict: CompatibilityVerdict,
  provider: LocalProviderId
): { code: 'MODEL_ENGINE_INCOMPATIBLE' | 'MODEL_FORMAT_LEGACY'; message: string } | null {
  switch (verdict.outcome) {
    case 'legacy_artifact':
      return {
        code: 'MODEL_FORMAT_LEGACY',
        message: `This file uses a legacy layout no current engine runs${verdict.replacement ? `; download ${verdict.replacement} instead` : ''}.`,
      }
    case 'unsupported':
      return { code: 'MODEL_ENGINE_INCOMPATIBLE', message: `This file cannot be run: ${verdict.reason}.` }
    case 'compatible':
    case 'engine_required':
    case 'engine_update_required':
      if (verdict.provider === null) return null
      if (verdict.provider !== provider) {
        return {
          code: 'MODEL_ENGINE_INCOMPATIBLE',
          message: `This model needs the ${verdict.provider} engine (${verdict.requires.join(', ')}); it cannot run on ${provider}.`,
        }
      }
      if (verdict.outcome === 'compatible') return null
      return { code: 'MODEL_ENGINE_INCOMPATIBLE', message: `${verdict.reason}.` }
    case 'inspection_required':
      return null
  }
}
