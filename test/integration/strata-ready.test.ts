import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { processStartId } from '../../src/lock/index.js'
import { randomFreePort } from '../../src/runtime/shared/index.js'
import {
  StrataControlProcess,
  StrataOwnedControl,
  StrataProcessInspector,
  StrataProcessJournal,
  StrataRuntime,
  runStrataPreparationStep,
  strataHttp,
} from '../../src/runtime/strata/index.js'
import { buildGguf } from '../helpers/gguf-builder.js'
const bundle = process.env.ATOMIC_TEST_STRATA_TREE
it.skipIf(!bundle || process.platform === 'win32')(
  'publishes a Strata session only after native Control probes generation, then unloads all children',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'strata-ready-'))
    const python = join(bundle!, 'control/python/bin/python3')
    const scopeDir = join(await (await import('node:fs/promises')).realpath(root), 'scope')
    const core = { pid: process.pid, instanceId: 'test-core', startId: (await processStartId(process.pid))! }
    const journal = await StrataProcessJournal.open(join(root, 'journal'), 'test')
    const gguf = join(root, 'tokenizer.gguf')
    const compute = join(root, 'fake-compute')
    const runtime = new StrataRuntime({
      prepare: async (modelId, generation) => {
        const profile = 'atomic-' + generation
        const opts = {
          platform: process.platform,
          bundleDir: bundle!,
          python,
          scopeDir,
          profile,
          ownerPid: core.pid,
          env: {},
        }
        const control = await StrataControlProcess.open(opts)
        const owned = new StrataOwnedControl(
          { generation, profile, modelId, cards: ['test-gpu'], core },
          journal,
          control,
          new StrataProcessInspector(opts),
          4000
        )
        const port = await randomFreePort([])
        const config = join(scopeDir, 'config.json')
        const apiKey = 'fixture-upstream-key'
        await writeFile(
          config,
          JSON.stringify({
            exe: compute,
            tokenizer: join(root, 'pack/tokenizer'),
            args: [],
            offline: true,
            model_name: modelId,
            host: '127.0.0.1',
            port,
            api_key: apiKey,
            log: join(root, 'compute.log'),
          }),
          { mode: 0o600 }
        )
        await control.create(config)
        return {
          build: bundle!,
          gpuId: 'test-gpu',
          modelPath: gguf,
          timeoutMs: 10_000,
          owner: owned,
          ...strataHttp(
            port,
            apiKey,
            modelId,
            { chat: true, tools: false, vision: false, reasoning: false, structured_output: true },
            4096,
            []
          ),
        }
      },
    })
    try {
      await writeFile(
        gguf,
        buildGguf({
          metadata: {
            'general.architecture': 'qwen4exp',
            'tokenizer.ggml.model': 'gpt2',
            'tokenizer.ggml.pre': 'qwen35',
            'tokenizer.ggml.tokens': {
              strings: [...Array.from({ length: 94 }, (_, i) => String.fromCharCode(i + 33)), 'ab'],
            },
            'tokenizer.ggml.merges': { strings: ['a b'] },
            'tokenizer.chat_template': 'a',
          },
          tensors: [],
        })
      )
      await runStrataPreparationStep(
        {
          python,
          controlDir: join(bundle!, 'control'),
          stagingDir: root,
          platform: process.platform,
          env: {},
        },
        {
          id: 'tokenizer',
          tool: 'tools/strata_tokenizer.py',
          args: ['--gguf', gguf, '--out', join(root, 'pack')],
          outputs: [],
        },
        new AbortController().signal
      )
      await writeFile(
        compute,
        `#!${python} -B
import sys
print("READY 4096 stop", flush=True)
for line in sys.stdin:
    if line.startswith("QUIT"): break
    if line.startswith("GEN "):
        print("T 64", flush=True)
        print("DONE 1 1 1 1 stop 0 0 0", flush=True)
`,
        { mode: 0o700 }
      )
      await chmod(compute, 0o700)
      const session = await runtime.load('fixture')
      expect(session.pid).toBeGreaterThan(0)
      expect(runtime.gpuOccupancy()).toMatchObject([{ state: 'ready' }])
      expect(await runtime.load('fixture')).toEqual(session)
      const reply = await fetch('http://127.0.0.1:' + session.port + '/v1/chat/completions', {
        method: 'POST',
        headers: { 'authorization': 'Bearer ' + session.api_key, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'fixture', messages: [{ role: 'user', content: 'a' }], max_tokens: 1 }),
      })
      expect(reply.status).toBe(200)
      expect(await reply.json()).toMatchObject({ usage: { completion_tokens: 1 } })
      expect(await runtime.unload('fixture')).toMatchObject({ success: true })
      expect(journal.list()).toEqual([])
      expect(runtime.gpuOccupancy()).toEqual([])
    } catch (error) {
      const logs = [
        join(root, 'compute.log'),
        ...(await readdir(join(scopeDir, 'runtime')).catch(() => []))
          .filter((path) => path.endsWith('.log'))
          .map((path) => join(scopeDir, 'runtime', path)),
      ]
      const output = await Promise.all(logs.map((path) => readFile(path, 'utf8').catch(() => '')))
      throw new Error(JSON.stringify(journal.list()) + '\n' + output.join('\n'), { cause: error })
    } finally {
      await runtime.shutdown()
      await rm(root, { recursive: true, force: true })
    }
  },
  30_000
)
