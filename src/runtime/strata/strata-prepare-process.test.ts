import { win32 } from 'node:path'
import { expect, it } from 'vitest'
import { strataConverterSpec } from './strata-prepare-process.js'
it('only invokes pinned converters, with isolated imports and an owner pipe', () => {
  const spec = strataConverterSpec(
    {
      python: '/bundle/control/python/bin/python3',
      controlDir: '/bundle/control',
      stagingDir: '/data/staging',
      platform: 'linux',
      env: { PATH: '/usr/bin:/bin', PYTHONPATH: '/evil', STRATA_NO_ACQUIRE: '1' },
    },
    {
      id: 'tokenizer',
      tool: 'tools/strata_tokenizer.py',
      args: ['--gguf', '/source/model.gguf', '--out', '/data/staging/pack'],
      outputs: [],
    }
  )
  expect(spec.stdin).toBe('pipe')
  expect(spec.args.slice(0, 3)).toEqual(['-I', '-B', '-c'])
  expect(spec.env).not.toHaveProperty('PYTHONPATH')
  expect(spec.env.STRATA_NO_ACQUIRE).toBe('1')
  expect(() =>
    strataConverterSpec(
      {
        python: '/python',
        controlDir: '/bundle/control',
        stagingDir: '/bundle/control/source',
        platform: 'linux',
        env: {},
      },
      { id: 'bad', tool: 'setup.py' as never, args: [], outputs: [] }
    )
  ).toThrow()
})

it('keeps the Windows launch directory short while passing staging paths explicitly', () => {
  const stagingDir = win32.join('C:\\data', ...Array.from({ length: 4 }, () => 'a'.repeat(70)))
  const output = win32.join(stagingDir, 'pack')
  const spec = strataConverterSpec(
    {
      python: 'C:\\bundle\\control\\python\\python.exe',
      controlDir: 'C:\\bundle\\control',
      stagingDir,
      platform: 'win32',
      env: { SYSTEMROOT: 'D:\\Windows' },
    },
    { id: 'tokenizer', tool: 'tools/strata_tokenizer.py', args: ['--out', output], outputs: [] }
  )

  expect(spec.cwd).toBe('D:\\Windows\\System32')
  expect(spec.args.slice(-3)).toEqual([
    win32.toNamespacedPath(stagingDir),
    '--out',
    win32.toNamespacedPath(output),
  ])
  expect(spec.env.TEMP).toBe(win32.toNamespacedPath(win32.join(stagingDir, '.tmp')))
})
