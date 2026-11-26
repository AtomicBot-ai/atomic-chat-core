import { it, expect, vi } from 'vitest'
import { startControlHarness } from '../../../../test/helpers/control-harness.js'
it('round-trips a nested model selection and rejects invalid modes and IDs', async () => {
  const selections = new Map<string, string | null>()
  const server = await startControlHarness({
    loras: {
      list: vi.fn(),
      search: vi.fn(),
      install: vi.fn(),
      remove: vi.fn(),
      cancel: vi.fn(),
      choices: async (mode, model) => ({
        target: 'org/model',
        adapterId: selections.get(mode + model) ?? null,
        files: [],
      }),
      select: async (mode, model, id) => {
        selections.set(mode + model, id)
      },
    },
  })
  try {
    const path = '/atomic/v1/loras/choices/chat/org/model'
    const put = (adapterId: unknown) =>
      server.get(path, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ adapterId }),
      })
    expect((await put(false)).status).toBe(400)
    expect((await put('c'.repeat(64))).status).toBe(200)
    expect(await (await server.get(path)).json()).toMatchObject({ adapterId: 'c'.repeat(64) })
    expect((await put(null)).status).toBe(200)
    expect(await (await server.get(path)).json()).toMatchObject({ adapterId: null })
    expect((await server.get(path.replace('/chat/', '/audio/'))).status).toBe(400)
  } finally {
    await server.server.close()
  }
})
