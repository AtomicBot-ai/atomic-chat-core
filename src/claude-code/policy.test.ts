import { describe, expect, it } from 'vitest'
import {
  cleanEnvironment,
  isSubscriptionAuth,
  modelSelector,
  parseCatalog,
  parseResult,
  validateRequest,
} from './policy.js'
const id = '684286da-7283-4e22-9436-c6f6c3c03015'
describe('Claude Code policy', () => {
  it.each(['api_key', 'oauth_token', undefined])(
    'rejects non-subscription authentication %s',
    (authMethod) => {
      expect(isSubscriptionAuth({ loggedIn: true, authMethod, apiProvider: 'firstParty' })).toBe(false)
    }
  )
  it('accepts only the first-party subscription session', () => {
    expect(isSubscriptionAuth({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' })).toBe(
      true
    )
    expect(isSubscriptionAuth({ loggedIn: false, authMethod: 'claude.ai', apiProvider: 'firstParty' })).toBe(
      false
    )
    expect(isSubscriptionAuth({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'bedrock' })).toBe(
      false
    )
  })
  it('keeps version and context names precise without displaying snapshot dates as versions', () => {
    const models = parseCatalog([
      { value: 'default', resolvedModel: 'claude-opus-5-5[1m]' },
      { value: 'claude-fable-5-1[1m]', resolvedModel: 'claude-fable-5-1' },
      { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001' },
      { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001' },
      { resolvedModel: 'claude--invalid' },
    ])
    expect(models.map((m) => [m.id, m.model, m.name])).toEqual([
      ['claude-code-default', 'claude-opus-5-5[1m]', 'Claude Opus 5.5 · 1M · default'],
      ['claude-fable-5-1[1m]', 'claude-fable-5-1[1m]', 'Claude Fable 5.1 · 1M'],
      ['claude-haiku-4-5-20251001', 'claude-haiku-4-5-20251001', 'Claude Haiku 4.5'],
    ])
    expect(() => parseCatalog([])).toThrow('no versioned models')
  })
  it('validates requests before starting a child', () => {
    const valid = {
      requestId: id,
      model: 'claude-fable-5-1[1m]',
      prompt: 'hello',
      system: null,
      sessionId: null,
    }
    expect(validateRequest(valid)).toEqual(valid)
    for (const invalid of [
      { ...valid, requestId: 'bad' },
      { ...valid, prompt: ' ' },
      { ...valid, prompt: 'x'.repeat(2 * 1024 * 1024 + 1) },
      { ...valid, sessionId: 'bad' },
      { ...valid, executable: 'arbitrary' },
      { ...valid, system: 42 },
    ])
      expect(() => validateRequest(invalid)).toThrow()
  })
  it('allows exact model IDs and legacy selections but never option strings or shell syntax', () => {
    expect(modelSelector('claude-code-default')).toBeUndefined()
    expect(modelSelector('claude-code-sonnet')).toBe('sonnet')
    expect(modelSelector('claude-fable-5-1[1m]')).toBe('claude-fable-5-1[1m]')
    for (const model of ['--dangerously-skip-permissions', 'claude-x; echo bad', 'claude--x', 'claude-X', ''])
      expect(() => modelSelector(model)).toThrow()
  })
  it('counts cached input and reports failure rather than a successful empty reply', () => {
    expect(
      parseResult({
        subtype: 'success',
        session_id: id,
        result: 'OK',
        usage: {
          input_tokens: 2,
          cache_read_input_tokens: 10,
          cache_creation_input_tokens: 5,
          output_tokens: 3,
        },
      })
    ).toEqual({ sessionId: id, text: 'OK', inputTokens: 17, outputTokens: 3 })
    expect(() => parseResult({ subtype: 'error_during_execution', errors: ['Usage limit reached'] })).toThrow(
      'Usage limit reached'
    )
    expect(() => parseResult({ subtype: 'success', session_id: 'invalid' })).toThrow('invalid session ID')
  })
  it('removes routing and credential overrides without changing the host environment or credential directory', () => {
    const env = {
      PATH: '/bin',
      ANTHROPIC_API_KEY: 'test-key',
      ANTHROPIC_BASE_URL: 'http://wrong',
      CLAUDE_CODE_OAUTH_TOKEN: 'test-token',
      CLAUDE_CONFIG_DIR: '/chosen/profile',
    }
    expect(cleanEnvironment(env)).toEqual({ PATH: '/bin', CLAUDE_CONFIG_DIR: '/chosen/profile' })
    expect(env.ANTHROPIC_API_KEY).toBe('test-key')
  })
})
