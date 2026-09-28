import { describe, expect, it, vi } from 'vitest'
import { AtomicCoreError } from '../../contracts/index.js'
import {
  containerLogs,
  createContainer,
  inspectContainer,
  inspectImage,
  removeContainer,
  runOnce,
  startContainer,
  stopContainer,
} from './operations.js'
import type { DockerCommandResult, DockerExec, ModelContainerCreateSpec } from './types.js'

const ok = (stdout = '', stderr = ''): DockerCommandResult => ({ code: 0, stdout, stderr })
const failed = (code: number | null, stderr: string, stdout = ''): DockerCommandResult => ({
  code,
  stdout,
  stderr,
})

const fakeExec = (result: DockerCommandResult | ((args: string[]) => DockerCommandResult)): DockerExec =>
  vi.fn(async (args: string[]) => (typeof result === 'function' ? result(args) : result))

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
    expect(await createContainer(exec, createSpec)).toEqual({ containerId: 'abc123def456' })
  })

  it('throws IO_ERROR when docker create fails', async () => {
    const exec = fakeExec(failed(1, 'Error: Conflict.'))
    await expect(createContainer(exec, createSpec)).rejects.toThrow(AtomicCoreError)
  })

  it('throws IO_ERROR when docker create exits 0 with no id', async () => {
    const exec = fakeExec(ok('  \n'))
    await expect(createContainer(exec, createSpec)).rejects.toMatchObject({ code: 'IO_ERROR' })
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
})

describe('runOnce', () => {
  it('returns the raw result without throwing, whatever the exit code', async () => {
    const exec = fakeExec(failed(1, 'CUDA driver version is insufficient'))
    const result = await runOnce(exec, { image, gpuUuid: 'GPU-1', command: ['nvidia-smi', '-L'] })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('CUDA driver version is insufficient')
  })
})
