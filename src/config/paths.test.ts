import { isAbsolute, join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../contracts/index.js'
import type { DataFolderEnv } from './data-folder.js'
import {
  backendExeCandidates,
  dataLayout,
  decodeManagedId,
  encodeManagedId,
  llamaServerExeName,
  managedSharedPaths,
  managedSharedRoot,
  modelDirFromId,
  modelIdFromDir,
  resolveDataRelative,
} from './paths.js'

const layout = dataLayout('/data')
/** The host's spelling of a POSIX-written path (`\data\…` on Windows), as `join` builds it. */
const native = (path: string) => join(path)

describe('dataLayout', () => {
  it('shares the GGUF tree between both llama.cpp providers and isolates backends', () => {
    expect(layout.provider('llamacpp-upstream').modelsDir).toBe(native('/data/llamacpp/models'))
    expect(layout.provider('llamacpp').modelsDir).toBe(native('/data/llamacpp/models'))
    expect(layout.provider('llamacpp-upstream').backendsDir).toBe(native('/data/llamacpp-upstream/backends'))
    expect(layout.provider('llamacpp').backendsDir).toBe(native('/data/llamacpp/backends'))
    expect(layout.provider('llamacpp').libDir).toBe(native('/data/llamacpp/lib'))
    expect(layout.provider('llamacpp-upstream').libDir).toBeUndefined()
    expect(layout.provider('mlx').modelsDir).toBe(native('/data/mlx/models'))
    expect(layout.provider('tensorrt-llm').modelsDir).toBe(native('/data/tensorrt-llm/models'))
  })
  it('puts every new file under <data>/atomic-core and keeps the legacy files at the root', () => {
    expect(layout.core.settings).toBe(native('/data/atomic-core/settings.json'))
    expect(layout.core.instanceLock).toBe(native('/data/atomic-core/instance.lock'))
    expect(layout.serverStateFile).toBe(native('/data/local-api-server.json'))
    expect(layout.chatgptAuthFile).toBe(native('/data/atomic-chatgpt-auth.json'))
    // The app's 2.0.40 tunnel journal; the core's own one lives under atomic-core/.
    expect(layout.legacyRemoteAccessTunnel).toBe(native('/data/remote-access-tunnel.json'))
    expect(layout.core.remoteAccessTunnel).toBe(native('/data/atomic-core/remote-access-tunnel.json'))
  })
  it('puts the execution journal under atomic-core/managed-runtimes/executions, keyed by container id', () => {
    expect(layout.managed.root).toBe(native('/data/atomic-core/managed-runtimes'))
    expect(layout.managed.executionsDir).toBe(native('/data/atomic-core/managed-runtimes/executions'))
    expect(layout.managed.executionFile('abc123')).toBe(
      native('/data/atomic-core/managed-runtimes/executions/abc123.json')
    )
  })
  it('keeps heartbeats, engine caches, the docker config and the watchdog script under the same scope root (task 2.12)', () => {
    const m = layout.managed
    expect(m.heartbeatsDir).toBe(native('/data/atomic-core/managed-runtimes/heartbeats'))
    expect(m.heartbeatDir('gen-1')).toBe(native('/data/atomic-core/managed-runtimes/heartbeats/gen-1'))
    expect(m.cachesDir).toBe(native('/data/atomic-core/managed-runtimes/caches'))
    expect(m.descriptorCachesDir('tensorrt-llm-1.2.1-r1')).toBe(
      native('/data/atomic-core/managed-runtimes/caches/tensorrt-llm-1.2.1-r1')
    )
    expect(m.engineCacheDir('tensorrt-llm-1.2.1-r1', 'qwen3-8b')).toBe(
      native('/data/atomic-core/managed-runtimes/caches/tensorrt-llm-1.2.1-r1/qwen3-8b')
    )
    expect(m.dockerConfigDir).toBe(native('/data/atomic-core/managed-runtimes/docker-config'))
    expect(m.watchdogScript).toBe(
      native('/data/atomic-core/managed-runtimes/watchdog/atomic-watchdog-entrypoint.sh')
    )
  })
  it('encodes every id it spells onto disk, so a model id or generation is always exactly one segment', () => {
    const m = layout.managed
    expect(m.engineCacheDir('d/../x', 'org/model:rev')).toBe(
      native('/data/atomic-core/managed-runtimes/caches/d%2F..%2Fx/org%2Fmodel%3Arev')
    )
    expect(m.engineCacheDir('..', '.')).toBe(native('/data/atomic-core/managed-runtimes/caches/%2E%2E/%2E'))
    expect(m.heartbeatDir('a/b')).toBe(native('/data/atomic-core/managed-runtimes/heartbeats/a%2Fb'))
    expect(() => m.engineCacheDir('', 'm')).toThrow(AtomicCoreError)
  })
  it("keeps image generation where the app's plugin put it", () => {
    // `state.rs` at 767ff6350: `<data>/diffusion/{backends,models,scratch}`, gallery in `<data>/images`.
    expect(layout.diffusion).toEqual({
      root: join('/data', 'diffusion'),
      backendsDir: join('/data', 'diffusion', 'backends'),
      modelsDir: join('/data', 'diffusion', 'models'),
      scratchDir: join('/data', 'diffusion', 'scratch'),
      defaultOutputDir: join('/data', 'images'),
      defaultVideoOutputDir: join('/data', 'videos'),
    })
  })
})

describe('path helpers', () => {
  it('names the executable per platform and lists both pack layouts', () => {
    expect(llamaServerExeName('win32')).toBe('llama-server.exe')
    expect(llamaServerExeName('darwin')).toBe('llama-server')
    expect(
      backendExeCandidates(layout.provider('llamacpp-upstream'), 'b10405', 'macos-arm64', 'llama-server')
    ).toEqual([
      native('/data/llamacpp-upstream/backends/b10405/macos-arm64/build/bin/llama-server'),
      native('/data/llamacpp-upstream/backends/b10405/macos-arm64/llama-server'),
    ])
  })
  it('maps model ids to nested directories and back with forward slashes', () => {
    const models = '/data/llamacpp/models'
    expect(modelDirFromId(models, 'org/model/q4')).toBe(native('/data/llamacpp/models/org/model/q4'))
    expect(modelIdFromDir(models, '/data/llamacpp/models/org/model/q4')).toBe('org/model/q4')
  })
  it('resolves model.yml paths relative to <data> unless absolute', () => {
    expect(resolveDataRelative('/data', 'llamacpp/models/x/model.gguf', isAbsolute)).toBe(
      native('/data/llamacpp/models/x/model.gguf')
    )
    expect(resolveDataRelative('/data', '/abs/model.gguf', isAbsolute)).toBe('/abs/model.gguf')
  })
})

describe('managed runtime paths', () => {
  const managedEnv = (platform: NodeJS.Platform, vars: NodeJS.ProcessEnv = {}): DataFolderEnv => ({
    platform,
    env: vars,
    homedir: '/home/u',
    exists: () => false,
    readFile: () => undefined,
  })

  it('encodes everything outside [A-Za-z0-9._-] as %XX of its UTF-8 bytes', () => {
    expect(encodeManagedId('nvidia/Llama-3.1-8B-Instruct-FP8')).toBe('nvidia%2FLlama-3.1-8B-Instruct-FP8')
    expect(encodeManagedId('a:b c')).toBe('a%3Ab%20c')
  })

  it('escapes the shapes that are legal characters but illegal directory names', () => {
    expect(encodeManagedId('.')).toBe('%2E')
    expect(encodeManagedId('..')).toBe('%2E%2E')
    expect(encodeManagedId('name.')).toBe('name%2E')
    expect(encodeManagedId('CON')).toBe('%43ON')
    expect(encodeManagedId('nul.json')).toBe('%6Eul.json')
    expect(encodeManagedId('LPT1.txt')).toBe('%4CPT1.txt')
    // Not a device name and not a run of dots: passes through untouched.
    expect(encodeManagedId('CONSOLE')).toBe('CONSOLE')
    expect(encodeManagedId('nulls')).toBe('nulls')
  })

  it('round-trips ids through the directory name, including non-Latin scripts and punctuation', () => {
    for (const id of [
      'nvidia/Qwen3-8B-FP8',
      'op/1',
      '日本語のモデル',
      'a b:c*d?e',
      '..hidden',
      String.fromCharCode(0x2028),
    ]) {
      const encoded = encodeManagedId(id)
      // Always exactly one path segment: no separator, never `.` or `..`.
      expect(encoded.includes('/')).toBe(false)
      expect(encoded).not.toBe('.')
      expect(encoded).not.toBe('..')
      expect(decodeManagedId(encoded)).toBe(id)
    }
  })

  it('refuses an empty id and a directory name that is not an encoded one', () => {
    expect(() => encodeManagedId('')).toThrow(AtomicCoreError)
    expect(() => decodeManagedId('%ZZ')).toThrow(AtomicCoreError)
    expect(() => decodeManagedId('%E0%A4%A')).toThrow(AtomicCoreError)
    // A lone stray continuation byte is not valid UTF-8 on its own.
    expect(() => decodeManagedId('%FF%FE')).toThrow(AtomicCoreError)
  })

  it('puts the shared environment under the user account, not under the movable data folder', () => {
    expect(managedSharedRoot(managedEnv('darwin'))).toBe(
      join('/home/u', 'Library', 'Application Support', 'atomic-managed-runtimes')
    )
    expect(managedSharedRoot(managedEnv('linux'))).toBe(
      join('/home/u', '.local', 'share', 'atomic-managed-runtimes')
    )
    expect(managedSharedRoot(managedEnv('win32', { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }))).toBe(
      join('C:\\Users\\u\\AppData\\Roaming', 'atomic-managed-runtimes')
    )
    // Moving the data folder must not strand the containers, nor make the CLI scope reinstall.
    expect(managedSharedRoot(managedEnv('linux', { ATOMIC_CORE_DATA_FOLDER: '/elsewhere' }))).toBe(
      join('/home/u', '.local', 'share', 'atomic-managed-runtimes')
    )
    expect(managedSharedRoot(managedEnv('linux', { ATOMIC_CORE_MANAGED_ROOT: '/tmp/fake' }))).toBe(
      '/tmp/fake'
    )
  })

  it('lays the shared root out as one record, one lock, the installations and the operations', () => {
    const shared = managedSharedPaths('/shared')
    expect(shared.environmentFile).toBe(native('/shared/environment.json'))
    expect(shared.lockFile).toBe(native('/shared/environment.lock'))
    expect(shared.installationsDir).toBe(native('/shared/installations'))
    expect(shared.operationsDir).toBe(native('/shared/operations'))
    expect(shared.installationFile('inst-1')).toBe(native('/shared/installations/inst-1/installation.json'))
    expect(shared.operationFile('op/1')).toBe(native('/shared/operations/op%2F1.json'))
  })

  it('lays the accepted-descriptor cache out under its own directory, keyed by descriptor_id', () => {
    const shared = managedSharedPaths('/shared')
    expect(shared.descriptorsDir).toBe(native('/shared/descriptors'))
    expect(shared.descriptorFile('tensorrt-llm-1.2.1-r1')).toBe(
      native('/shared/descriptors/tensorrt-llm-1.2.1-r1.json')
    )
    expect(shared.descriptorLatestFile).toBe(native('/shared/descriptors/latest.json'))
  })

  it('writes a descriptor_id as one directory entry instead of nesting on its slash', () => {
    const dir = relative('/shared/descriptors', managedSharedPaths('/shared').descriptorFile('a/b')).split(
      sep
    )
    expect(dir).toHaveLength(1)
  })

  it('writes an operation id as one directory instead of nesting on its slash', () => {
    const dir = relative('/shared/operations', managedSharedPaths('/shared').operationFile('a/b')).split(sep)
    expect(dir).toHaveLength(1)
  })
})
