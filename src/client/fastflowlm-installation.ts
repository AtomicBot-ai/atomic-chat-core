import type { FastFlowLmModelDescriptor, FastFlowLmFile, FastFlowLmSource } from '../contracts/index.js'
import profiles from './fastflowlm-native-profiles.json' with { type: 'json' }
const PROTOCOL = /^flm-(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-r[1-9]\d*$/
const ID = /^[a-z0-9][a-z0-9._-]*$/
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error('Invalid FastFlowLM catalog: ' + message)
}
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const matches = (v: unknown, pattern: RegExp): v is string => typeof v === 'string' && pattern.test(v)
const positive = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v > 0
function safePath(v: unknown): v is string {
  return (
    matches(v, /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/) &&
    v
      .split('/')
      .every(
        (part) =>
          part !== '' && !part.endsWith('.') && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
      )
  )
}

export function isFastFlowLmVariantId(value: unknown): value is string {
  return matches(value, ID) && safePath(value)
}

/** Read only fields used by the local protocol. Credentials and catalog annotations never enter model.yml. */
export function parseFastFlowLmDescriptor(d: unknown): FastFlowLmModelDescriptor {
  check(record(d), 'descriptor')
  check(
    matches(d.model_id, ID) &&
      isFastFlowLmVariantId(d.variant_id) &&
      matches(d.checkpoint, /^[a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9._-]*$/),
    'model identity'
  )
  check(
    matches(d.minimum_flm_version, PROTOCOL) &&
      d.minimum_flm_version.match(/\d+/g)!.every((n) => Number.isSafeInteger(Number(n))) &&
      d.local_only_protocol === 1 &&
      d.npu_generation === 'xdna2',
    'requirements'
  )
  check(positive(d.context_length) && Number(d.context_length) <= 2147483647, 'context length')
  const caps = d.capabilities
  check(
    record(caps) &&
      caps.chat === true &&
      ['tools', 'reasoning', 'structured_output'].every((k) => typeof caps[k] === 'boolean'),
    'capabilities'
  )
  check(
    Array.isArray(d.sources) && d.sources.length && Array.isArray(d.files) && d.files.length,
    'empty file plan'
  )
  const sourceRows: FastFlowLmSource[] = []
  const fileRows: FastFlowLmFile[] = []
  const sources = new Set<string>()
  for (const s of d.sources) {
    check(
      record(s) &&
        matches(s.id, ID) &&
        !sources.has(s.id) &&
        matches(s.repo, /^[\w.-]+\/[\w.-]+$/) &&
        !s.repo.split('/').some((part) => part === '.' || part === '..') &&
        matches(s.revision, /^[a-f0-9]{40}$/),
      'immutable source'
    )
    check(s.host === undefined || s.host === 'github' || s.host === 'huggingface', 'source host')
    sourceRows.push({ id: s.id, repo: s.repo, revision: s.revision, ...(s.host ? { host: s.host } : {}) })
    sources.add(s.id)
  }
  const paths = new Map<string, string>()
  const unusedSources = new Set(sources)
  for (const f of d.files) {
    check(
      record(f) &&
        typeof f.source === 'string' &&
        sources.has(f.source) &&
        safePath(f.path) &&
        safePath(f.source_path) &&
        positive(f.size) &&
        matches(f.sha256, /^[a-f0-9]{64}$/),
      'file'
    )
    const key = f.path.toLowerCase()
    check(!paths.has(key), 'duplicate target')
    check(!['model.yml', 'flm'].includes(key.split('/')[0]!), 'installer-owned path')
    fileRows.push({
      source: f.source,
      source_path: f.source_path,
      path: f.path,
      size: f.size as number,
      sha256: f.sha256,
    })
    paths.set(key, f.path)
    unusedSources.delete(f.source)
  }
  check(!unusedSources.size, 'unused source')
  const directories = new Map<string, string>()
  for (const path of paths.values()) {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) {
      const name = parts.slice(0, i).join('/')
      const folded = name.toLowerCase()
      check(!paths.has(folded), 'file used as a directory')
      check(!directories.has(folded) || directories.get(folded) === name, 'inconsistent directory casing')
      directories.set(folded, name)
    }
  }
  return {
    model_id: d.model_id,
    variant_id: d.variant_id,
    checkpoint: d.checkpoint,
    minimum_flm_version: d.minimum_flm_version,
    local_only_protocol: 1,
    npu_generation: 'xdna2',
    context_length: d.context_length as number,
    capabilities: {
      chat: true,
      tools: caps.tools === true,
      reasoning: caps.reasoning === true,
      structured_output: caps.structured_output === true,
    },
    sources: sourceRows,
    files: fileRows,
  }
}

export const FLM_MODEL_LIST_PATH = 'flm/model_list.json'
export const FLM_MODEL_INFO_PATH = 'flm/model_info.json'

/** Native launch fields are selected from the pinned FLM source. The installer supplies all file identities. */
export function buildFastFlowLmConfig(input: FastFlowLmModelDescriptor) {
  const d = parseFastFlowLmDescriptor(input)
  check(Object.hasOwn(profiles, d.checkpoint), 'unknown native checkpoint ' + d.checkpoint)
  const {
    files: required,
    default_context_length: limit,
    ...native
  } = profiles[d.checkpoint as keyof typeof profiles]
  const files = d.files.map((f) => f.path)
  check(
    required.every((path) => files.includes(path)),
    'missing native checkpoint file'
  )
  check(d.context_length <= limit, 'context exceeds native profile')
  const labels = 'label' in native ? native.label : []
  check(!d.capabilities.tools || labels.includes('tool-calling'), 'tools unsupported by native checkpoint')
  check(
    !d.capabilities.reasoning || native.details.think || labels.includes('reasoning'),
    'reasoning unsupported by native checkpoint'
  )
  const [family, variant] = d.checkpoint.split(':') as [string, string]
  const entry = {
    ...structuredClone(native),
    supported_platforms: ['aie2p'],
    default_context_length: d.context_length,
    name: d.variant_id,
    files,
  }
  return {
    modelList: { model_path: '.', models: { [family]: { [variant]: entry } } },
    modelInfo: {
      [d.checkpoint]: d.files.map(({ path, size, sha256 }) => ({ type: 'file', path, size, sha256 })),
    },
  }
}
