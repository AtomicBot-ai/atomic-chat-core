import { afterEach, describe, expect, it } from 'vitest'
import { makeAgentHome, type AgentHome } from '../../../test/helpers/agent-config-home.js'
import { legacyEnvAgentWriter, removeLegacyEnvBlocks, removeMarkedEnvBlock } from './legacy-env-block.js'

const MARKER = '# Atomic Chat - OpenHands Config'
const BLOCK = `${MARKER}\nexport LLM_MODEL='openai/qwen'\nexport LLM_BASE_URL='http://127.0.0.1:1337/v1'\n${MARKER}`

let home: AgentHome | undefined
afterEach(async () => {
  await home?.cleanup()
  home = undefined
})

describe('the shell block an older release wrote', () => {
  it('goes from between its paired markers, and the user’s own export of the same variable stays', () => {
    const rc = `export PATH=/x\n${BLOCK}\nexport LLM_MODEL='mine'\n`
    expect(removeMarkedEnvBlock(rc, MARKER)).toBe("export PATH=/x\nexport LLM_MODEL='mine'\n")
    expect(removeMarkedEnvBlock('export A=1\n', MARKER)).toBe('export A=1\n')
  })

  it('is removed from every rc file that has it, and other files are left untouched', async () => {
    home = await makeAgentHome()
    await home.fs.write('.zshenv', `${BLOCK}\nexport KEEP=1\n`)
    await home.fs.write('.bashrc', 'alias ll="ls -l"\n')
    await removeLegacyEnvBlocks(home.fs, MARKER)
    expect(await home.read('.zshenv')).toBe('export KEEP=1\n')
    expect(await home.read('.bashrc')).toBe('alias ll="ls -l"\n')
    expect(await home.fs.read('.bash_profile')).toBeUndefined()
  })

  it('is what Connect does for an environment-only agent, except on Windows where the app cleans up', async () => {
    home = await makeAgentHome()
    await home.fs.write('.zshenv', `${BLOCK}\n`)
    const write = legacyEnvAgentWriter(MARKER)
    await write({ fs: home.fs, platform: 'win32' } as Parameters<typeof write>[0])
    expect(await home.read('.zshenv')).toBe(`${BLOCK}\n`)
    await write({ fs: home.fs, platform: 'darwin' } as Parameters<typeof write>[0])
    expect(await home.read('.zshenv')).toBe('')
  })
})
