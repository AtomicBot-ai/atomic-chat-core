import { AtomicCoreError } from '../contracts/index.js'
import type { ClaudeCodeModel, ClaudeCodeRequest, ClaudeCodeResult } from '../contracts/index.js'

export const MAX_EVENT_BYTES = 4 * 1024 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MODEL = /^claude-[a-z0-9]+(?:-[a-z0-9]+)*(?:\[1m\])?$/

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

export function isSubscriptionAuth(value: unknown): boolean {
  const auth = object(value)
  return (
    auth['loggedIn'] === true && auth['authMethod'] === 'claude.ai' && auth['apiProvider'] === 'firstParty'
  )
}

export function modelSelector(id: string): string | undefined {
  if (id === 'claude-code-default') return undefined
  const legacy = /^claude-code-(opus|sonnet|haiku|fable)$/.exec(id)
  if (legacy) return legacy[1]
  if (id.length < 120 && MODEL.test(id)) return id
  throw new AtomicCoreError('INVALID_ARGUMENT', 'Unknown Claude Code model selection.')
}

export function validateRequest(input: unknown): ClaudeCodeRequest {
  const value = object(input)
  if (
    Object.keys(value).some(
      (key) => !['requestId', 'model', 'prompt', 'system', 'sessionId'].includes(key)
    ) ||
    typeof value['requestId'] !== 'string' ||
    !UUID.test(value['requestId']) ||
    typeof value['model'] !== 'string' ||
    typeof value['prompt'] !== 'string' ||
    !value['prompt'].trim() ||
    new TextEncoder().encode(value['prompt']).length > 2 * 1024 * 1024 ||
    (value['system'] != null &&
      (typeof value['system'] !== 'string' ||
        new TextEncoder().encode(value['system']).length > 2 * 1024 * 1024)) ||
    (value['sessionId'] != null && (typeof value['sessionId'] !== 'string' || !UUID.test(value['sessionId'])))
  ) {
    throw new AtomicCoreError(
      'INVALID_ARGUMENT',
      'Claude Code requires a valid request ID and text under 2 MiB.'
    )
  }
  modelSelector(value['model'])
  return value as unknown as ClaudeCodeRequest
}

export function parseCatalog(value: unknown): ClaudeCodeModel[] {
  const models: ClaudeCodeModel[] = []
  for (const candidate of Array.isArray(value) ? value : []) {
    const row = object(candidate)
    const resolved = row['resolvedModel']
    if (typeof resolved !== 'string' || resolved.length >= 120 || !MODEL.test(resolved)) continue
    const selector = typeof row['value'] === 'string' ? row['value'] : resolved
    const model = selector.endsWith('[1m]') && !resolved.endsWith('[1m]') ? `${resolved}[1m]` : resolved
    const parts = model
      .replace(/\[1m\]$/, '')
      .slice(7)
      .split('-')
    const family = parts[0] as string
    const version: string[] = []
    for (const part of parts.slice(1)) {
      if (!/^\d{1,7}$/.test(part)) break
      version.push(part)
    }
    let name = version.length
      ? `Claude ${family[0]?.toUpperCase()}${family.slice(1)} ${version.join('.')}`
      : String(row['displayName'] ?? resolved)
    if (model.endsWith('[1m]')) name += ' · 1M'
    const id = selector === 'default' ? 'claude-code-default' : model
    if (selector === 'default') name += ' · default'
    if (!models.some((row) => row.id === id))
      models.push({
        id,
        model,
        name,
        description: typeof row['description'] === 'string' ? row['description'] : '',
      })
  }
  if (!models.length)
    throw new AtomicCoreError(
      'PROCESS_ERROR',
      'Claude Code returned no versioned models. Update Claude Code and check the connection again.'
    )
  return models
}

export function parseResult(value: unknown): ClaudeCodeResult {
  const row = object(value)
  if (row['is_error'] === true || row['subtype'] !== 'success') {
    const details = Array.isArray(row['errors'])
      ? row['errors'].filter((item): item is string => typeof item === 'string').join('; ')
      : ''
    throw new AtomicCoreError(
      'PROCESS_ERROR',
      (
        details ||
        (typeof row['result'] === 'string' ? row['result'] : '') ||
        'Claude Code could not complete the response. Check your login and plan limits.'
      ).slice(0, 2000)
    )
  }
  if (typeof row['session_id'] !== 'string' || !UUID.test(row['session_id']))
    throw new AtomicCoreError('PROCESS_ERROR', 'Claude Code returned an invalid session ID.')
  const usage = object(row['usage'])
  const count = (key: string) =>
    typeof usage[key] === 'number' && Number.isFinite(usage[key]) && usage[key] >= 0 ? usage[key] : 0
  return {
    sessionId: row['session_id'],
    text: typeof row['result'] === 'string' ? row['result'] : '',
    inputTokens:
      count('input_tokens') + count('cache_read_input_tokens') + count('cache_creation_input_tokens'),
    outputTokens: count('output_tokens'),
  }
}

export function cleanEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key]) => key === 'CLAUDE_CONFIG_DIR' || (!key.startsWith('ANTHROPIC_') && !key.startsWith('CLAUDE_'))
    )
  )
}
