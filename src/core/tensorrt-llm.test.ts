import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../contracts/index.js'
import { ExecutionJournal } from '../runtime/container/index.js'
import { parseRuntimeDescriptor } from '../runtime/environment/index.js'
import { TensorrtLlmRuntime } from '../runtime/tensorrt-llm/index.js'
import { FakeDocker } from '../../test/helpers/fake-docker-exec.js'
import { makeTmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import { managedTestHost, wireTensorrtLlm } from './tensorrt-llm.js'
import type { WireTensorrtLlmOptions } from './tensorrt-llm.js'

let data: TmpDataFolder
beforeEach(async () => {
  data = await makeTmpDataFolder('core-trt-wiring-')
})
afterEach(() => data.cleanup())

const options = (over: Partial<WireTensorrtLlmOptions> = {}): WireTensorrtLlmOptions => ({
  platform: 'linux',
  arch: 'x64',
  layout: data.layout,
  instanceId: 'core-1',
  scope: 'app',
  managedRoot: join(data.root, 'managed'),
  descriptors: {
    forInstallation: async (id) => ({
      kind: 'unsupported',
      error: new AtomicCoreError('MANAGED_METADATA_INVALID', 'not cached', id),
    }),
  },
  containers: Promise.resolve(null),
  trustedHosts: [],
  settings: () => ({}),
  emit: () => {},
  log: () => {},
  ...over,
})

describe('managedTestHost', () => {
  it('is null outside tests, and names the stand-in docker and nvidia-smi of the folder it points at', () => {
    expect(managedTestHost({})).toBeNull()
    expect(managedTestHost({ ATOMIC_MANAGED_TEST_HOST: '  ' })).toBeNull()
    expect(managedTestHost({ ATOMIC_MANAGED_TEST_HOST: '/tmp/host' })).toEqual({
      dir: '/tmp/host',
      dockerPath: join('/tmp/host', 'bin', 'docker'),
      nvidiaSmi: join('/tmp/host', 'bin', 'nvidia-smi'),
    })
  })
})

describe('wireTensorrtLlm', () => {
  it.each<NodeJS.Platform>(['darwin', 'win32', 'freebsd'])('offers no provider on %s', (platform) => {
    expect(wireTensorrtLlm(options({ platform }))).toBeNull()
  })

  it('offers the provider on Linux', async () => {
    const runtime = wireTensorrtLlm(options())
    expect(runtime).toBeInstanceOf(TensorrtLlmRuntime)
    await runtime?.shutdown()
  })

  it('refuses a load with MANAGED_ADAPTER_UNAVAILABLE on a Linux host with no docker CLI', async () => {
    const runtime = wireTensorrtLlm(options()) as TensorrtLlmRuntime
    await expect(runtime.load('m')).rejects.toMatchObject({ code: 'MANAGED_ADAPTER_UNAVAILABLE' })
  })

  it('with a ready installation, looks the model up in <data>/tensorrt-llm/models and asks the host for its cards', async () => {
    const managedRoot = join(data.root, 'managed')
    const descriptorPath = fileURLToPath(
      new URL('../../test/fixtures/runtimes/tensorrt-llm.json', import.meta.url)
    )
    const descriptor = parseRuntimeDescriptor(JSON.parse(await readFile(descriptorPath, 'utf8')))
    await mkdir(join(managedRoot, 'descriptors'), { recursive: true })
    await copyFile(descriptorPath, join(managedRoot, 'descriptors', `${descriptor.descriptor_id}.json`))
    await mkdir(join(managedRoot, 'installations', 'trt-1'), { recursive: true })
    await writeFile(
      join(managedRoot, 'installations', 'trt-1', 'installation.json'),
      JSON.stringify({
        schema_version: 1,
        installation: {
          installation_id: 'trt-1',
          engine_id: 'tensorrt-llm',
          environment_id: 'default',
          active_descriptor_id: descriptor.descriptor_id,
          candidate_descriptor_id: null,
          availability: 'supported',
          status: 'ready',
        },
      })
    )
    const docker = new FakeDocker()
    const journal = await ExecutionJournal.open(data.layout)
    const runtime = wireTensorrtLlm(
      options({
        managedRoot,
        descriptors: { forInstallation: async () => ({ kind: 'available', descriptor }) },
        containers: Promise.resolve({ exec: docker.exec, journal }),
        nvidiaSmi: join(data.root, 'no-such-nvidia-smi'),
      })
    ) as TensorrtLlmRuntime
    await expect(runtime.load('not-installed')).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND' })

    const modelDir = join(data.layout.provider('tensorrt-llm').modelsDir, 'm')
    await mkdir(modelDir, { recursive: true })
    await writeFile(join(modelDir, 'model.yml'), 'architectures: [LlamaForCausalLM]\n')
    // No nvidia-smi answers on this host: no card, so nothing is created.
    await expect(runtime.load('m')).rejects.toMatchObject({ code: 'MANAGED_PREREQUISITE_BLOCKED' })
    expect(docker.subcommands()).toEqual(['info'])
    await runtime.shutdown()
  })

  it('reads installations from the shared root: none there refuses the load before any docker call', async () => {
    const docker = new FakeDocker()
    const journal = await ExecutionJournal.open(data.layout)
    const runtime = wireTensorrtLlm(
      options({ containers: Promise.resolve({ exec: docker.exec, journal }) })
    ) as TensorrtLlmRuntime
    await expect(runtime.load('m')).rejects.toMatchObject({ code: 'MANAGED_ADAPTER_UNAVAILABLE' })
    expect(docker.calls).toEqual([])
    await runtime.shutdown()
  })
})
