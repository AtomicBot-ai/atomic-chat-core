import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { runStrataPreparationStep } from '../../src/runtime/strata/strata-prepare-process.js'
import { buildGguf } from '../helpers/gguf-builder.js'

const bundle = process.env['ATOMIC_TEST_STRATA_TREE']
it.skipIf(!bundle)(
  'denies converter network, children and source writes while permitting staging output',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'strata-converter-'))
    try {
      const controlDir = join(dir, 'control'),
        stagingDir = join(dir, 'staging')
      await mkdir(join(controlDir, 'tools'), { recursive: true })
      await mkdir(stagingDir)
      const source = join(dir, 'source')
      await writeFile(source, 'immutable')
      await writeFile(
        join(controlDir, 'tools/strata_tokenizer.py'),
        `import os,socket,subprocess,sys\nfrom pathlib import Path\nblocked=[]\nfor label,action in [('network',lambda:socket.create_connection(('example.invalid',443))),('child',lambda:subprocess.run([sys.executable,'-c','pass'])),('source',lambda:Path(sys.argv[1]).write_text('changed'))]:\n try: action()\n except PermissionError: blocked.append(label)\nPath(sys.argv[2]).write_text(','.join(blocked))\n`
      )
      await runStrataPreparationStep(
        {
          python: join(
            bundle!,
            process.platform === 'win32' ? 'control/python/python.exe' : 'control/python/bin/python3'
          ),
          controlDir,
          stagingDir,
          platform: process.platform,
          env: { PATH: '/usr/bin:/bin' },
        },
        {
          id: 'guard',
          tool: 'tools/strata_tokenizer.py',
          args: [source, join(stagingDir, 'result')],
          outputs: [],
        },
        new AbortController().signal
      )
      expect(await readFile(source, 'utf8')).toBe('immutable')
      expect(await readFile(join(stagingDir, 'result'), 'utf8')).toBe('network,child,source')
      const abort = new AbortController()
      await writeFile(join(controlDir, 'tools/strata_tokenizer.py'), 'import time\ntime.sleep(60)\n')
      const work = runStrataPreparationStep(
        {
          python: join(
            bundle!,
            process.platform === 'win32' ? 'control/python/python.exe' : 'control/python/bin/python3'
          ),
          controlDir,
          stagingDir,
          platform: process.platform,
          env: {},
        },
        { id: 'cancel', tool: 'tools/strata_tokenizer.py', args: [], outputs: [] },
        abort.signal,
        async () => {
          abort.abort()
        }
      )
      await expect(work).rejects.toMatchObject({ code: 'MODEL_LOAD_CANCELLED' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
)

it.skipIf(!bundle)(
  'extracts a tiny Qwen tokenizer through the pinned tool without rewriting its GGUF',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'strata-tokenizer-'))
    try {
      const source = join(dir, 'model.gguf'),
        stagingDir = join(dir, 'staging')
      await mkdir(stagingDir)
      const gguf = buildGguf({
        metadata: {
          'general.architecture': 'qwen35moe',
          'tokenizer.ggml.model': 'gpt2',
          'tokenizer.ggml.pre': 'qwen35',
          'tokenizer.ggml.tokens': { strings: ['a', 'b', 'ab'] },
          'tokenizer.ggml.merges': { strings: ['a b'] },
          'tokenizer.chat_template': '{{ messages[0].content }}',
        },
        tensors: [],
      })
      await writeFile(source, gguf)
      await runStrataPreparationStep(
        {
          python: join(
            bundle!,
            process.platform === 'win32' ? 'control/python/python.exe' : 'control/python/bin/python3'
          ),
          controlDir: join(bundle!, 'control'),
          stagingDir,
          platform: process.platform,
          env: {},
        },
        {
          id: 'tokenizer',
          tool: 'tools/strata_tokenizer.py',
          args: ['--gguf', source, '--out', join(stagingDir, 'pack')],
          outputs: [],
        },
        new AbortController().signal
      )
      expect(await readFile(source)).toEqual(gguf)
      expect(JSON.parse(await readFile(join(stagingDir, 'pack/tokenizer/vocab.json'), 'utf8'))).toEqual({
        a: 0,
        b: 1,
        ab: 2,
      })
      expect(await readFile(join(stagingDir, 'pack/tokenizer/chat_template.jinja'), 'utf8')).toBe(
        '{{ messages[0].content }}'
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
)
