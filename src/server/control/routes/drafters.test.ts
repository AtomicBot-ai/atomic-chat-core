import { it, expect, vi } from 'vitest'
import { startControlHarness } from '../../../../test/helpers/control-harness.js'

it('keeps the search term separate from its target and scopes selection to a nested upstream installation', async () => {
  const target = 'Qwen/Qwen3-4B'
  const search = vi.fn(async () => ({ target, results: [], partial: false, hasMore: false }))
  const select = vi.fn(async () => {})
  const harness = await startControlHarness({
    drafters: {
      search,
      variants: vi.fn(),
      select,
      choices: vi.fn(),
      selection: vi.fn(),
      list: vi.fn(),
      remove: vi.fn(),
      install: vi.fn(),
      cancel: vi.fn(),
    },
  })
  try {
    const path = '/atomic/v1/models/llamacpp-upstream/owner/model/drafter'
    const put = (id: unknown) =>
      harness.get(path, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      })
    expect((await harness.get('/atomic/v1/drafters/search?target=Qwen%2FQwen3-4B&q=Q8&live=1')).status).toBe(
      200
    )
    expect(search).toHaveBeenCalledWith(undefined, 'Q8', true, target, 0)
    expect((await harness.get('/atomic/v1/drafters/search?target=invalid')).status).toBe(400)
    expect((await put(false)).status).toBe(400)
    expect(select).not.toHaveBeenCalled()
    expect((await put(null)).status).toBe(200)
    expect(select).toHaveBeenCalledWith('owner/model', null)
  } finally {
    await harness.server.close()
  }
})
