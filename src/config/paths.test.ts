import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
  managedHostPath,
  managedScopePaths,
  managedSharedPaths,
  managedSharedRoot,
  modelDirFromId,
  modelIdFromDir,
  resolveDataRelative,
} from './paths.js'

const layout = dataLayout('/data')

describe('dataLayout', () => {
  it('shares the GGUF tree between both llama.cpp providers and isolates backends', () => {
    expect(layout.provider('llamacpp-upstream').modelsDir).toBe('/data/llamacpp/models')
    expect(layout.provider('llamacpp').modelsDir).toBe('/data/llamacpp/models')
    expect(layout.provider('llamacpp-upstream').backendsDir).toBe('/data/llamacpp-upstream/backends')
    expect(layout.provider('llamacpp').backendsDir).toBe('/data/llamacpp/backends')
    expect(layout.provider('llamacpp').libDir).toBe('/data/llamacpp/lib')
    expect(layout.provider('llamacpp-upstream').libDir).toBeUndefined()
    expect(layout.provider('mlx').modelsDir).toBe('/data/mlx/models')
  })
  it('puts every new file under <data>/atomic-core and keeps the legacy files at the root', () => {
    expect(layout.core.settings).toBe('/data/atomic-core/settings.json')
    expect(layout.core.instanceLock).toBe('/data/atomic-core/instance.lock')
    expect(layout.serverStateFile).toBe('/data/local-api-server.json')
    expect(layout.chatgptAuthFile).toBe('/data/atomic-chatgpt-auth.json')
    // The app's 2.0.40 tunnel journal; the core's own one lives under atomic-core/.
    expect(layout.legacyRemoteAccessTunnel).toBe('/data/remote-access-tunnel.json')
    expect(layout.core.remoteAccessTunnel).toBe('/data/atomic-core/remote-access-tunnel.json')
  })
  it("keeps image generation where the app's plugin put it", () => {
    // `state.rs` at 767ff6350: `<data>/diffusion/{backends,models,scratch}`, gallery in `<data>/images`.
    expect(layout.diffusion).toEqual({
      root: '/data/diffusion',
      backendsDir: '/data/diffusion/backends',
      modelsDir: '/data/diffusion/models',
      scratchDir: '/data/diffusion/scratch',
      defaultOutputDir: '/data/images',
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
      '/data/llamacpp-upstream/backends/b10405/macos-arm64/build/bin/llama-server',
      '/data/llamacpp-upstream/backends/b10405/macos-arm64/llama-server',
    ])
  })
  it('maps model ids to nested directories and back with forward slashes', () => {
    const models = '/data/llamacpp/models'
    expect(modelDirFromId(models, 'org/model/q4')).toBe('/data/llamacpp/models/org/model/q4')
    expect(modelIdFromDir(models, '/data/llamacpp/models/org/model/q4')).toBe('org/model/q4')
  })
  it('resolves model.yml paths relative to <data> unless absolute', () => {
    expect(resolveDataRelative('/data', 'llamacpp/models/x/model.gguf', isAbsolute)).toBe(
      '/data/llamacpp/models/x/model.gguf'
    )
    expect(resolveDataRelative('/data', '/abs/model.gguf', isAbsolute)).toBe('/abs/model.gguf')
  })
})

describe('managed runtime paths', () => {
  const managedEnv = (platform: NodeJS.Platform, vars: NodeJS.ProcessEnv = {}): DataFolderEnv => ({
    platform,
    env: vars,
    homedir: platform === 'win32' ? 'C:\\Users\\u' : '/home/u',
    exists: () => false,
    readFile: () => undefined,
  })

  it('keeps what one scope owns under its own atomic-core, beside the existing core files', () => {
    expect(layout.managed.root).toBe('/data/atomic-core/managed-runtimes')
    expect(layout.managed.executionsDir).toBe('/data/atomic-core/managed-runtimes/executions')
    expect(layout.managed.heartbeatsDir).toBe('/data/atomic-core/managed-runtimes/heartbeats')
    expect(layout.managed.artifactsDir).toBe('/data/atomic-core/managed-runtimes/artifacts')
    expect(layout.managed.cachesDir).toBe('/data/atomic-core/managed-runtimes/caches')
  })

  it('leaves every path that existed before this feature exactly where it was', () => {
    // Adding the managed subtree must not move a single byte a previous release wrote.
    expect(layout.provider('llamacpp').modelsDir).toBe('/data/llamacpp/models')
    expect(layout.provider('llamacpp-upstream').backendsDir).toBe('/data/llamacpp-upstream/backends')
    expect(layout.provider('mlx').modelsDir).toBe('/data/mlx/models')
    expect(layout.core.settings).toBe('/data/atomic-core/settings.json')
    expect(layout.core.instanceLock).toBe('/data/atomic-core/instance.lock')
    expect(layout.serverStateFile).toBe('/data/local-api-server.json')
    expect(layout.diffusion.modelsDir).toBe('/data/diffusion/models')
    expect(layout.diffusion.defaultOutputDir).toBe('/data/images')
  })

  it('separates caches by engine, release and model so two engines never read each other\u2019s', () => {
    expect(layout.managed.cacheDir('tensorrt-llm', 'trtllm-1.3.0rc27', 'a1')).toBe(
      '/data/atomic-core/managed-runtimes/caches/tensorrt-llm/trtllm-1.3.0rc27/a1'
    )
    expect(layout.managed.cacheDir('vllm', 'trtllm-1.3.0rc27', 'a1')).not.toBe(
      layout.managed.cacheDir('tensorrt-llm', 'trtllm-1.3.0rc27', 'a1')
    )
  })

  it('writes a model repository id as one directory instead of nesting on its slash', () => {
    const dir = layout.managed.artifactDir('nvidia/Llama-3.1-8B-Instruct-FP8')
    expect(dir).toBe('/data/atomic-core/managed-runtimes/artifacts/nvidia%2FLlama-3.1-8B-Instruct-FP8')
    // One segment below artifacts/, not two: `nvidia` must not become a directory of its own.
    expect(relative('/data/atomic-core/managed-runtimes/artifacts', dir).split(sep)).toHaveLength(1)
  })

  it('keeps a traversal, a bare dot and a device name inside the folder they were asked for', () => {
    const artifacts = '/data/atomic-core/managed-runtimes/artifacts'
    for (const id of ['..', '.', '../../etc/passwd', '..\\..\\windows', 'CON', 'nul.json', 'name.']) {
      const segments = relative(artifacts, layout.managed.artifactDir(id)).split(sep)
      // One directory, and not one of the two names that would mean somewhere else. A name may
      // still begin with dots — `../../etc/passwd` becomes `..%2F..%2Fetc%2Fpasswd`, which is a
      // single odd-looking directory and cannot climb anywhere, because the separators are gone.
      expect(segments).toHaveLength(1)
      expect(segments[0]).not.toBe('..')
      expect(segments[0]).not.toBe('.')
      expect(isAbsolute(segments[0] as string)).toBe(false)
    }
    // A device name is escaped at its first byte, a trailing dot at the dot itself: Windows accepts
    // neither spelling, and both still decode back to what the caller asked for.
    expect(encodeManagedId('CON')).toBe('%43ON')
    expect(encodeManagedId('nul.json')).toBe('%6Eul.json')
    expect(encodeManagedId('LPT1.txt')).toBe('%4CPT1.txt')
    // A name that merely starts like a device is an ordinary name and is left alone.
    expect(encodeManagedId('CONSOLE')).toBe('CONSOLE')
    expect(encodeManagedId('nulls')).toBe('nulls')
    expect(encodeManagedId('name.')).toBe('name%2E')
    expect(encodeManagedId('..')).toBe('%2E%2E')
  })

  it('round-trips ids through the directory name, including non-Latin scripts and punctuation', () => {
    for (const id of [
      'nvidia/Llama-3.1-8B-Instruct-FP8',
      'модель/тест',
      '日本語のモデル',
      'a b:c*d?e"f<g>h|i',
      'sha256:abc',
      '..',
      'CON',
      '100%',
    ]) {
      const encoded = encodeManagedId(id)
      expect(encoded).not.toContain('/')
      expect(encoded).not.toContain('\\')
      expect(decodeManagedId(encoded)).toBe(id)
    }
  })

  it('refuses an empty id and a directory name that is not an encoded one', () => {
    expect(() => encodeManagedId('')).toThrow(AtomicCoreError)
    expect(() => decodeManagedId('%ZZ')).toThrow(AtomicCoreError)
    expect(() => decodeManagedId('%E0%A4%A')).toThrow(AtomicCoreError)
    // Bytes that are not valid UTF-8 are a corrupt name, not a lossy one.
    expect(() => decodeManagedId('%FF%FE')).toThrow(AtomicCoreError)
  })

  it('refuses to hand back a path inside the WSL guest as if it were a Windows path', () => {
    expect(managedHostPath({ kind: 'native', storage_domain: 'app', absolute_path: 'C:\\data\\m' })).toBe(
      'C:\\data\\m'
    )
    expect(() =>
      managedHostPath({
        kind: 'guest',
        storage_domain: 'atomic-wsl',
        environment_id: 'env-1',
        guest_path: '/home/atomic/models/m',
      })
    ).toThrow(AtomicCoreError)
  })

  it('puts the shared environment under the user account, not under the movable data folder', () => {
    expect(managedSharedRoot(managedEnv('darwin'))).toBe(
      '/home/u/Library/Application Support/atomic-managed-runtimes'
    )
    expect(managedSharedRoot(managedEnv('linux'))).toBe('/home/u/.local/share/atomic-managed-runtimes')
    // Joined with this host's separator, exactly as the production code joins it.
    expect(managedSharedRoot(managedEnv('win32', { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }))).toBe(
      join('C:\\Users\\u\\AppData\\Roaming', 'atomic-managed-runtimes')
    )
    // The app scope and the CLI scope have different data folders and must still land on one
    // environment: nothing here reads ATOMIC_CORE_DATA_FOLDER.
    expect(managedSharedRoot(managedEnv('linux', { ATOMIC_CORE_DATA_FOLDER: '/elsewhere' }))).toBe(
      '/home/u/.local/share/atomic-managed-runtimes'
    )
    expect(managedSharedRoot(managedEnv('linux', { ATOMIC_CORE_MANAGED_ROOT: '/tmp/fake' }))).toBe(
      '/tmp/fake'
    )
  })

  it('gives a running container its own journal entry and its own heartbeat file', () => {
    expect(layout.managed.executionFile('exec/1')).toBe(
      '/data/atomic-core/managed-runtimes/executions/exec%2F1.json'
    )
    expect(layout.managed.heartbeatFile('exec/1')).toBe(
      '/data/atomic-core/managed-runtimes/heartbeats/exec%2F1'
    )
  })

  it('lays the shared root out as one record, one lock, the installations and the operations', () => {
    const shared = managedSharedPaths('/shared')
    expect(shared.environmentFile).toBe('/shared/environment.json')
    expect(shared.lockFile).toBe('/shared/environment.lock')
    expect(shared.installationFile('inst/1')).toBe('/shared/installations/inst%2F1/installation.json')
    expect(shared.operationFile('op 1')).toBe('/shared/operations/op%201.json')
  })

  it('creates nothing on disk: these are names, and the caller decides what to make', () => {
    const root = join(tmpdir(), `atomic-paths-${randomUUID()}`)
    const scope = managedScopePaths(join(root, 'atomic-core'))
    const shared = managedSharedPaths(root)
    scope.artifactDir('a')
    scope.cacheDir('e', 'd', 'a')
    scope.executionFile('x')
    scope.heartbeatFile('x')
    shared.installationFile('i')
    shared.operationFile('o')

    expect(existsSync(root)).toBe(false)
  })
})
