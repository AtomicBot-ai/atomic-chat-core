import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeTmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import { recordingIo } from '../io.js'
import { modelsCommand } from './models.js'

let data: TmpDataFolder

beforeEach(async () => {
  data = await makeTmpDataFolder('atomic-core-cli-')
})
afterEach(async () => {
  await data.cleanup()
})

const io = () => recordingIo()
const folder = () => ['--data-folder', data.root]

describe('models list', () => {
  it('prints a table of chat models with sizes and capabilities', async () => {
    await data.writeModel('Owner/Repo-GGUF', {
      size_bytes: 3_221_225_472,
      capabilities: ['tools', 'vision'],
    })
    await data.writeModel('small', { size_bytes: 512 })
    const out = io()
    expect(await modelsCommand(['list', ...folder()], out)).toBe(0)
    const text = out.out.join('')
    expect(text).toContain('MODEL ID')
    expect(text).toContain('Owner/Repo-GGUF')
    expect(text).toContain('3.0 GB')
    expect(text).toContain('tools, vision')
    expect(text).toContain('512 B')
    expect(text).toContain('-') // no capabilities on the small one
  })

  it('hides embedding models, as the Rust CLI does', async () => {
    await data.writeModel('chat')
    await data.writeModel('embed', { embedding: true })
    const out = io()
    await modelsCommand(['list', ...folder()], out)
    expect(out.out.join('')).toContain('chat')
    expect(out.out.join('')).not.toContain('embed')
  })

  it('prints the documented JSON fields with --json', async () => {
    await data.writeModel('m', { name: 'Model', size_bytes: 10, capabilities: ['tools'] })
    const out = io()
    expect(await modelsCommand(['list', '--json', ...folder()], out)).toBe(0)
    expect(JSON.parse(out.out.join(''))).toEqual([
      {
        id: 'm',
        name: 'Model',
        model_path: 'llamacpp/models/m/model.gguf',
        size_bytes: 10,
        capabilities: ['tools'],
        mmproj_path: null,
      },
    ])
  })

  it('explains an empty folder on stderr and still exits 0', async () => {
    const out = io()
    expect(await modelsCommand(['list', ...folder()], out)).toBe(0)
    expect(out.err.join('')).toContain('No chat models installed')
    expect(out.out.join('')).toBe('')
    expect(JSON.parse((await runJson()) || '[]')).toEqual([])
  })

  it('rejects an unknown subcommand', async () => {
    const out = io()
    expect(await modelsCommand(['delete', ...folder()], out)).toBe(2)
    expect(out.err.join('')).toContain('Unknown models subcommand')
  })

  async function runJson(): Promise<string> {
    const out = io()
    await modelsCommand(['list', '--json', ...folder()], out)
    return out.out.join('')
  }
})
