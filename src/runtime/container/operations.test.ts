import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { mkdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AtomicCoreError } from '../../contracts/index.js'
import {
  publishedHostPort,
  containerLogs,
  containersUsingImage,
  createContainer,
  inspectContainer,
  inspectImage,
  removeContainer,
  removeImage,
  runOnce,
  startContainer,
  stopContainer,
} from './operations.js'
import type { DockerCommandResult, DockerExec, ModelContainerCreateSpec, Realpath } from './types.js'
import type { WslDistributionTransport } from '../wsl/index.js'
import { guestRealpath } from './wsl-exec.js'

const ok = (stdout = '', stderr = ''): DockerCommandResult => ({ code: 0, stdout, stderr })
const failed = (code: number | null, stderr: string, stdout = ''): DockerCommandResult => ({
  code,
  stdout,
  stderr,
})

const fakeExec = (result: DockerCommandResult | ((args: string[]) => DockerCommandResult)): DockerExec =>
  vi.fn(async (args: string[]) => (typeof result === 'function' ? result(args) : result))

/**
 * `createContainer` now canonicalizes every mount source through `realpath` by default (review round
 * 2, item 2) — every test below uses synthetic, non-existent paths, so it must inject this identity
 * stand-in rather than hit the real filesystem. The real-filesystem symlink behavior is covered by
 * its own `describe` block further down.
 */
const identityRealpath: Realpath = async (path) => path
const noRealpathIO = { realpath: identityRealpath }

const image = {
  repository: 'nvcr.io/nvidia/tensorrt-llm/release',
  digest: `sha256:${'a'.repeat(64)}`,
} as const

const createSpec: ModelContainerCreateSpec = {
  image,
  gpuUuid: 'GPU-1',
  selinux: false,
  mounts: {
    model: { source: '/d/model' },
    engineCache: { source: '/d/cache' },
    entrypoint: { source: '/d/entrypoint.sh' },
    heartbeat: { source: '/d/heartbeat' },
  },
  publication: { host: '127.0.0.1', host_port: 12345, container_port: 8000 },
  labels: { engine_id: 'tensorrt-llm', scope: 'app', instance_id: 'core-1' },
}

describe('inspectImage / inspectContainer', () => {
  it('parses the JSON array docker prints and returns the first element as found', async () => {
    const exec = fakeExec(ok(JSON.stringify([{ Id: 'sha256:xyz' }])))
    const result = await inspectImage(exec, image)
    expect(result).toEqual({ found: true, value: { Id: 'sha256:xyz' } })
  })

  it('reports found: false without throwing when the image is absent', async () => {
    const exec = fakeExec(failed(1, 'Error: No such image: nvcr.io/x@sha256:aa\n'))
    expect(await inspectImage(exec, image)).toEqual({ found: false, value: null })
  })

  it('reports found: false without throwing when the container is absent', async () => {
    const exec = fakeExec(failed(1, 'Error: No such container: c1\n'))
    expect(await inspectContainer(exec, 'c1')).toEqual({ found: false, value: null })
  })

  it('throws IO_ERROR on an unexpected docker failure (not "no such ...")', async () => {
    const exec = fakeExec(failed(1, 'Cannot connect to the Docker daemon\n'))
    await expect(inspectContainer(exec, 'c1')).rejects.toMatchObject({
      code: 'IO_ERROR',
    })
  })

  it('throws AtomicCoreError, not a raw SyntaxError, when docker exits 0 with unparseable stdout (review round 1, item 12)', async () => {
    const exec = fakeExec(ok('not json at all'))
    await expect(inspectContainer(exec, 'c1')).rejects.toBeInstanceOf(AtomicCoreError)
    await expect(inspectContainer(exec, 'c1')).rejects.toMatchObject({ code: 'IO_ERROR' })
  })
})

describe('createContainer', () => {
  it('returns the container id docker printed', async () => {
    const exec = fakeExec(ok('abc123def456\n'))
    expect(await createContainer(exec, createSpec, noRealpathIO)).toEqual({ containerId: 'abc123def456' })
  })

  it('throws IO_ERROR when docker create fails', async () => {
    const exec = fakeExec(failed(1, 'Error: Conflict.'))
    await expect(createContainer(exec, createSpec, noRealpathIO)).rejects.toThrow(AtomicCoreError)
  })

  it('throws IO_ERROR when docker create exits 0 with no id', async () => {
    const exec = fakeExec(ok('  \n'))
    await expect(createContainer(exec, createSpec, noRealpathIO)).rejects.toMatchObject({ code: 'IO_ERROR' })
  })

  it('canonicalizes every mount source (and selinuxDataRoot) through realpath before building argv (review round 2, item 2)', async () => {
    let capturedArgv: string[] = []
    const exec: DockerExec = async (args) => {
      capturedArgv = args
      return ok('c1')
    }
    const canonicalize: Realpath = async (path) => `/canonical${path}`
    const spec: ModelContainerCreateSpec = {
      ...createSpec,
      selinux: true,
      selinuxDataRoot: '/d',
    }
    await createContainer(exec, spec, { realpath: canonicalize })
    const joined = capturedArgv.join(' ')
    expect(joined).toContain('/canonical/d/model:/atomic/model:ro,z')
    expect(joined).toContain('/canonical/d/cache:/atomic/engine-cache:rw,z')
    // The uncanonicalized source never appears as its own mount ("-v /d/model:..."); only the
    // canonicalized "/canonical/d/model:..." form does (which, as a substring, does contain
    // "/d/model:" — that is expected and fine, it is not a false pass).
    expect(joined).not.toContain('-v /d/model:')
  })

  it('wraps a realpath failure in AtomicCoreError IO_ERROR, naming which mount could not be resolved', async () => {
    const exec = fakeExec(ok('c1'))
    const failing: Realpath = async (path) => {
      if (path === '/d/cache') throw new Error('ENOENT: no such file or directory')
      return path
    }
    await expect(createContainer(exec, createSpec, { realpath: failing })).rejects.toMatchObject({
      code: 'IO_ERROR',
    })
    try {
      await createContainer(exec, createSpec, { realpath: failing })
      expect.unreachable()
    } catch (error) {
      expect((error as AtomicCoreError).message).toContain('engine cache mount source')
    }
  })

  it('does not resolve selinuxDataRoot when it was not given', async () => {
    const seen: string[] = []
    const recording: Realpath = async (path) => {
      seen.push(path)
      return path
    }
    await createContainer(fakeExec(ok('c1')), createSpec, { realpath: recording })
    expect(seen).toEqual(['/d/model', '/d/cache', '/d/entrypoint.sh', '/d/heartbeat'])
  })
})

describe('createContainer symlink resolution against a real filesystem (review round 2, item 2, controller ruling)', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('refuses a mount source that is a symlink inside the SELinux data root pointing outside it', async () => {
    const dataRoot = realpathSync(mkdtempSync(join(tmpdir(), 'container-symlink-root-')))
    dirs.push(dataRoot)
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'container-symlink-outside-')))
    dirs.push(outside)

    // Real directories for the three mounts that stay honest, plus one symlink inside the root that
    // resolves to somewhere outside it — the actual attack this ruling defends against.
    const cache = join(dataRoot, 'cache')
    const entrypoint = join(dataRoot, 'entrypoint')
    const heartbeat = join(dataRoot, 'heartbeat')
    await Promise.all([mkdir(cache), mkdir(entrypoint), mkdir(heartbeat)])
    const evilLink = join(dataRoot, 'model-escape')
    await symlink(outside, evilLink)

    const spec: ModelContainerCreateSpec = {
      ...createSpec,
      selinux: true,
      selinuxDataRoot: dataRoot,
      mounts: {
        model: { source: evilLink },
        engineCache: { source: cache },
        entrypoint: { source: entrypoint },
        heartbeat: { source: heartbeat },
      },
    }
    // No injected realpath: this is the real `node:fs/promises` default, on a real symlink.
    await expect(createContainer(fakeExec(ok('c1')), spec)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
  })

  it('allows a symlink inside the data root that points to another location inside it, with the canonical (resolved) path in argv', async () => {
    const dataRoot = realpathSync(mkdtempSync(join(tmpdir(), 'container-symlink-root-')))
    dirs.push(dataRoot)

    const realModel = join(dataRoot, 'real-model')
    const cache = join(dataRoot, 'cache')
    const entrypoint = join(dataRoot, 'entrypoint')
    const heartbeat = join(dataRoot, 'heartbeat')
    await Promise.all([mkdir(realModel), mkdir(cache), mkdir(entrypoint), mkdir(heartbeat)])
    const modelLink = join(dataRoot, 'model-link')
    await symlink(realModel, modelLink)

    const spec: ModelContainerCreateSpec = {
      ...createSpec,
      selinux: true,
      selinuxDataRoot: dataRoot,
      mounts: {
        model: { source: modelLink },
        engineCache: { source: cache },
        entrypoint: { source: entrypoint },
        heartbeat: { source: heartbeat },
      },
    }
    let capturedArgv: string[] = []
    const exec: DockerExec = async (args) => {
      capturedArgv = args
      return ok('c1')
    }
    await createContainer(exec, spec)
    const joined = capturedArgv.join(' ')
    // The symlink's own path never appears; only its resolved target does.
    expect(joined).not.toContain(`${modelLink}:`)
    expect(joined).toContain(`${realModel}:/atomic/model:ro,z`)
  })
})

describe('startContainer', () => {
  it('resolves on success', async () => {
    await expect(startContainer(fakeExec(ok('c1')), 'c1')).resolves.toBeUndefined()
  })

  it('throws IO_ERROR on failure', async () => {
    await expect(startContainer(fakeExec(failed(1, 'no such container')), 'c1')).rejects.toMatchObject({
      code: 'IO_ERROR',
    })
  })
})

describe('stopContainer', () => {
  it('is confirmed exited when docker answers with code 0', async () => {
    const outcome = await stopContainer(fakeExec(ok('c1')), 'c1', 10)
    expect(outcome).toEqual({ confirmed: true, status: 'exited' })
  })

  it('is confirmed absent when docker reports "no such container"', async () => {
    const outcome = await stopContainer(fakeExec(failed(1, 'Error: No such container: c1')), 'c1', 10)
    expect(outcome).toEqual({ confirmed: true, status: 'absent' })
  })

  it('is NOT confirmed on the real failure shape exec.ts actually produces: a resolved result with code: null (review round 1, item 3)', async () => {
    // `runDockerCommand` never rejects — an exec deadline resolves with `code: null` and an
    // explanatory stderr, it does not throw. `failed(null, ...)` is that shape.
    const outcome = await stopContainer(
      fakeExec(failed(null, 'docker did not answer within 15000 ms')),
      'c1',
      10
    )
    expect(outcome).toEqual({ confirmed: false, reason: 'docker did not answer within 15000 ms' })
  })

  it('is NOT confirmed when the exec call itself throws (a distinct, defensive path for a non-standard DockerExec)', async () => {
    const exec: DockerExec = vi.fn(async () => {
      throw new Error('docker did not answer within 30000 ms')
    })
    const outcome = await stopContainer(exec, 'c1', 10)
    expect(outcome.confirmed).toBe(false)
    if (!outcome.confirmed) expect(outcome.reason).toContain('did not answer')
  })

  it('is NOT confirmed on an unrecognized docker error', async () => {
    const outcome = await stopContainer(fakeExec(failed(1, 'Cannot connect to the Docker daemon')), 'c1', 10)
    expect(outcome.confirmed).toBe(false)
  })

  it('extends the exec deadline past --time by a margin, so a legitimately slow stop is not cut short (review round 1, item 3)', async () => {
    const exec = fakeExec(ok('c1'))
    await stopContainer(exec, 'c1', 45)
    expect(exec).toHaveBeenCalledWith(expect.any(Array), { timeoutMs: 45 * 1000 + 5_000 })
  })

  it('builds the stop argv (and can throw INVALID_ARGUMENT) outside the try, before any exec call (review round 1, item 9)', async () => {
    const exec: DockerExec = vi.fn()
    await expect(stopContainer(exec, 'c1', -1)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(exec).not.toHaveBeenCalled()
  })
})

describe('removeContainer', () => {
  it('resolves on success', async () => {
    await expect(removeContainer(fakeExec(ok('c1')), 'c1')).resolves.toBeUndefined()
  })

  it('resolves (idempotent) when the container is already gone', async () => {
    await expect(
      removeContainer(fakeExec(failed(1, 'Error: No such container: c1')), 'c1')
    ).resolves.toBeUndefined()
  })

  it('throws IO_ERROR on an unexpected failure', async () => {
    await expect(removeContainer(fakeExec(failed(1, 'device or resource busy')), 'c1')).rejects.toMatchObject(
      {
        code: 'IO_ERROR',
      }
    )
  })
})

describe('containersUsingImage / removeImage (task 2.6)', () => {
  it('lists the ids of every container created from the image', async () => {
    await expect(containersUsingImage(fakeExec(ok('c1\nc2\n')), image)).resolves.toEqual(['c1', 'c2'])
    await expect(containersUsingImage(fakeExec(ok('')), image)).resolves.toEqual([])
  })

  it('fails loudly rather than reporting no users when docker cannot answer', async () => {
    await expect(containersUsingImage(fakeExec(failed(1, 'permission denied')), image)).rejects.toMatchObject(
      { code: 'IO_ERROR' }
    )
  })

  it('removes an image, and treats one already gone as removed', async () => {
    await expect(removeImage(fakeExec(ok('Untagged: x')), image)).resolves.toBe('removed')
    await expect(
      removeImage(
        fakeExec(failed(1, `Error response from daemon: No such image: ${image.repository}`)),
        image
      )
    ).resolves.toBe('absent')
    await expect(
      removeImage(fakeExec(failed(1, 'image is being used by stopped container')), image)
    ).rejects.toMatchObject({ code: 'IO_ERROR' })
  })
})

describe('containerLogs', () => {
  it('returns stdout as is when stderr is empty', async () => {
    const exec = fakeExec(ok('line1\nline2\n'))
    expect(await containerLogs(exec, 'c1', 200)).toBe('line1\nline2\n')
  })

  it('merges stdout and stderr chronologically by their --timestamps prefix (review round 1, item 2)', async () => {
    const exec = fakeExec(
      ok(
        '2024-01-01T00:00:00.000000000Z starting up\n2024-01-01T00:00:02.000000000Z ready\n',
        '2024-01-01T00:00:01.000000000Z a warning on stderr\n'
      )
    )
    expect(await containerLogs(exec, 'c1', 200)).toBe(
      '2024-01-01T00:00:00.000000000Z starting up\n' +
        '2024-01-01T00:00:01.000000000Z a warning on stderr\n' +
        '2024-01-01T00:00:02.000000000Z ready\n'
    )
  })

  it('includes an OOM message that only appears on stderr — previously silently dropped', async () => {
    const exec = fakeExec(
      ok(
        '2024-01-01T00:00:00.000000000Z loading weights\n',
        '2024-01-01T00:00:05.000000000Z CUDA out of memory\n'
      )
    )
    const logs = await containerLogs(exec, 'c1', 200)
    expect(logs).toContain('CUDA out of memory')
  })

  it('throws IO_ERROR on failure', async () => {
    const exec = fakeExec(failed(1, 'no such container'))
    await expect(containerLogs(exec, 'c1', 200)).rejects.toMatchObject({ code: 'IO_ERROR' })
  })

  it("asks docker for a tail count, or for the whole log with 'all'", async () => {
    const asked: string[][] = []
    const exec = fakeExec((args) => {
      asked.push(args)
      return ok('line\n')
    })
    await containerLogs(exec, 'c1', 200)
    await containerLogs(exec, 'c1', 'all')
    expect(asked.map((args) => args[args.indexOf('--tail') + 1])).toEqual(['200', 'all'])
  })
})

describe('runOnce', () => {
  it('returns the raw result without throwing, whatever the exit code', async () => {
    const exec = fakeExec(failed(1, 'CUDA driver version is insufficient'))
    const result = await runOnce(exec, { image, gpuUuid: 'GPU-1', command: ['nvidia-smi', '-L'] })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('CUDA driver version is insufficient')
  })
})

describe('createContainer on Windows: mount sources resolved in the WSL guest (change add-tensorrt-llm-windows, task 2.6)', () => {
  it('runs realpath in the guest for every mount, where Docker will bind it, and builds argv from its answers', async () => {
    const resolved: string[][] = []
    const transport: WslDistributionTransport = {
      name: 'AtomicChat',
      exec: async (argv) => {
        resolved.push(argv)
        return { code: 0, stdout: `${argv[argv.length - 1]}\n`, stderr: '' }
      },
      hold: () => {
        throw new Error('no hold')
      },
    }
    let capturedArgv: string[] = []
    const exec: DockerExec = async (args) => {
      capturedArgv = args
      return ok('c1')
    }
    const guest = '/var/lib/atomic-chat/scopes/k1'
    const spec: ModelContainerCreateSpec = {
      ...createSpec,
      mounts: {
        model: { source: `${guest}/models/tensorrt-llm/m` },
        engineCache: { source: `${guest}/caches/d/m` },
        entrypoint: { source: `${guest}/watchdog/atomic-watchdog-entrypoint.sh` },
        heartbeat: { source: `${guest}/heartbeats/g1` },
      },
      user: { uid: 1000, gid: 1000 },
    }
    await createContainer(exec, spec, { realpath: guestRealpath(transport) })
    expect(resolved.map((argv) => argv.slice(0, 3))).toEqual(Array(4).fill(['realpath', '-e', '--']))
    expect(capturedArgv.join(' ')).toContain(`${guest}/models/tensorrt-llm/m:/atomic/model:ro`)
    expect(capturedArgv.join(' ')).toContain('--user 1000:1000')
  })
})

describe('publishedHostPort (change add-tensorrt-llm-windows, task 2.7)', () => {
  it('reads the loopback port Docker chose', async () => {
    expect(await publishedHostPort(fakeExec(ok('127.0.0.1:49153\n')), 'c1', 8000)).toBe(49153)
  })

  it('refuses a publication on anything but 127.0.0.1', async () => {
    await expect(publishedHostPort(fakeExec(ok('0.0.0.0:49153\n')), 'c1', 8000)).rejects.toMatchObject({
      code: 'FORBIDDEN_HOST',
    })
  })

  it('fails when docker port did not answer', async () => {
    await expect(
      publishedHostPort(fakeExec(failed(1, 'Error: No public port')), 'c1', 8000)
    ).rejects.toMatchObject({
      code: 'IO_ERROR',
    })
  })
})
