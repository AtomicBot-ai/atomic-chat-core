import { afterEach, describe, expect, it } from 'vitest'
import { agentInput, makeAgentHome, type AgentHome } from '../../../test/helpers/agent-config-home.js'
import {
  atomicAgentEmbeddingBaseUrl,
  atomicAgentLocalLlamaEntry,
  atomicAgentPatchConfig,
  configureAtomicAgent,
} from './atomic-agent.js'

let home: AgentHome
afterEach(async () => {
  await home?.cleanup()
})

describe("the agent's own local-llama entry", () => {
  it('is mode-aware: managed ignores localModels.url and follows the daemon port', () => {
    expect(
      atomicAgentLocalLlamaEntry({
        localModels: { mode: 'managed', url: 'http://ignored:1', managed: { port: 1234 } },
      })
    ).toMatchObject({ url: 'http://127.0.0.1:1234' })
  })

  it('falls back to the default llama URL when localModels.url is empty rather than absent', () => {
    expect(atomicAgentLocalLlamaEntry({ localModels: { url: '' } })).toMatchObject({
      url: 'http://127.0.0.1:8080',
      baseUrl: 'http://127.0.0.1:8080',
    })
  })

  it('splits chat from embeddings only when embeddings are enabled', () => {
    // Not enabled: embeddings resolve to the chat URL, so the entry cannot repoint them.
    expect(atomicAgentEmbeddingBaseUrl({ localModels: { embeddings: { port: 1 } } }, 'chat')).toBe('chat')
    // Enabled with neither url nor port: the agent's own default embeddings port.
    expect(atomicAgentEmbeddingBaseUrl({ localModels: { embeddings: { enabled: true } } }, 'chat')).toBe(
      'http://127.0.0.1:19092'
    )
  })
})

describe('patching an Atomic Agent config', () => {
  it('refuses a whitespace-only model before touching anything', async () => {
    home = await makeAgentHome()
    await expect(configureAtomicAgent(agentInput(home.fs, { model: '  ' }))).rejects.toThrow(
      'Atomic Agent needs a model: none is running.'
    )
    expect(await home.tree()).toEqual({})
  })

  it('replaces a providers list that is not an array, then seeds the default entry', () => {
    const out = atomicAgentPatchConfig({ llm: { providers: 'nope' } }, 'u', 'm', 'k') as {
      llm: { providers: Array<{ id: string }> }
    }
    expect(out.llm.providers.map((p) => p.id)).toEqual(['local-llama', 'atomic-chat'])
  })

  it('keeps a working embedding selection and never repairs it to us', () => {
    const seeded = {
      llm: { providers: [{ id: 'other' }], activeEmbeddingProvider: 'other' },
    }
    const out = atomicAgentPatchConfig(seeded, 'u', 'm', 'k') as { llm: Record<string, unknown> }
    expect(out.llm['activeEmbeddingProvider']).toBe('other')
    expect(out.llm['activeTextProvider']).toBe('atomic-chat')
  })

  it('ignores a non-numeric requestTimeoutMs on our entry rather than carrying it through', () => {
    const seeded = { llm: { providers: [{ id: 'atomic-chat', requestTimeoutMs: 'soon' }] } }
    const out = atomicAgentPatchConfig(seeded, 'u', 'm', 'k') as {
      llm: { providers: Array<Record<string, unknown>> }
    }
    expect(out.llm.providers[0]?.['requestTimeoutMs']).toBe(300000)
  })
})

describe('configuring Atomic Agent', () => {
  it('honours ATOMIC_AGENT_STATE_DIR, trimming the value', async () => {
    home = await makeAgentHome()
    await configureAtomicAgent(agentInput(home.fs, { env: { ATOMIC_AGENT_STATE_DIR: ' state ' } }))
    expect(Object.keys(await home.tree())).toEqual(['state/config.json'])
  })
})
