import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { StrataControlProcess } from '../../src/runtime/strata/strata-control-process.js'

const bundle = process.env['ATOMIC_TEST_STRATA_TREE']
it.skipIf(!bundle)('runs pinned Control profile/status with packaged Python and no user state', async () => {
  const scopeDir = await mkdtemp(join(tmpdir(), 'strata-control-native-'))
  try {
    const profile = 'atomic-' + 'a'.repeat(32)
    const control = await StrataControlProcess.open({
      platform: process.platform,
      bundleDir: bundle!,
      python: join(
        bundle!,
        process.platform === 'win32' ? 'control/python/python.exe' : 'control/python/bin/python3'
      ),
      scopeDir,
      ownerPid: process.pid,
      profile,
      env: {
        ...process.env,
        PYTHONHOME: '/nonexistent',
        PYTHONPATH: '/nonexistent',
        STRATA_RUNTIME_DIR: '/nonexistent',
        STRATA_PROFILE_DIR: '/nonexistent',
      },
    })
    const config = join(scopeDir, 'config.json')
    await writeFile(
      config,
      JSON.stringify({
        exe: join(bundle!, 'components/qwen/strata'),
        tokenizer: join(scopeDir, 'tokenizer'),
        args: [],
      }),
      { mode: 0o600 }
    )
    await control.create(config)
    const saved = JSON.parse(await readFile(join(scopeDir, 'profiles', profile + '.json'), 'utf8'))
    expect(saved).toMatchObject({ id: profile, schema_version: 1, overrides: {} })
    expect((await readdir(join(scopeDir, 'profiles'))).filter((f) => f.endsWith('.json'))).toEqual([
      profile + '.json',
    ])
    expect(await control.status()).toEqual({ state: 'stopped' })
  } finally {
    await rm(scopeDir, { recursive: true, force: true })
  }
})

it.skipIf(!bundle || process.platform === 'win32')(
  'records the real Control owner and confirms exit after a failed start',
  async () => {
    const { realpath } = await import('node:fs/promises')
    const { processStartId } = await import('../../src/lock/index.js')
    const { StrataOwnedControl, StrataProcessInspector, StrataProcessJournal } =
      await import('../../src/runtime/strata/index.js')
    const scopeDir = await realpath(await mkdtemp(join(tmpdir(), 'strata-control-lifecycle-')))
    const generation = 'a'.repeat(32)
    const profile = 'atomic-' + generation
    const options = {
      platform: process.platform,
      bundleDir: bundle!,
      scopeDir,
      profile,
      ownerPid: process.pid,
      env: {},
      python: join(bundle!, 'control/python/bin/python3'),
    }
    const inspector = new StrataProcessInspector(options)
    const journal = await StrataProcessJournal.open(scopeDir, 'test')
    const control = await StrataControlProcess.open(options)
    const owner = new StrataOwnedControl(
      {
        generation,
        profile,
        modelId: 'fixture',
        cards: ['test-gpu'],
        core: { instanceId: 'fixture-core', pid: process.pid, startId: (await processStartId(process.pid))! },
      },
      journal,
      control,
      inspector,
      4000
    )
    try {
      const config = join(scopeDir, 'config.json')
      await writeFile(
        config,
        JSON.stringify({
          exe: join(bundle!, 'components/qwen/strata'),
          tokenizer: join(scopeDir, 'absent-tokenizer'),
          args: [],
          offline: true,
          model_name: 'fixture',
          host: '127.0.0.1',
          api_key: 'test-key',
        }),
        { mode: 0o600 }
      )
      await control.create(config)
      expect(await owner.start(15_000)).toMatchObject({ state: 'starting' })
      expect(journal.list()[0]!.processes).toContainEqual(expect.objectContaining({ role: 'launcher' }))
      expect((await inspector.snapshot()).processes).toContainEqual(
        expect.objectContaining({ role: 'owner' })
      )
      expect(await owner.stop()).toBe(true)
      expect(journal.list()).toEqual([])
    } finally {
      await owner.stop()
      await rm(scopeDir, { recursive: true, force: true })
    }
  },
  30_000
)
