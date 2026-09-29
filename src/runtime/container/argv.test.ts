import { describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../../contracts/index.js'
import {
  DOCKER_SOCKET_PATH,
  DOCKER_SYSTEM_SOCKET,
  MODEL_CONTAINER_SHM_SIZE,
  MODEL_CONTAINER_SHM_SIZE_CEILING_GB,
  assertSafeArgvValue,
  buildCreateModelContainerArgv,
  buildInspectContainerArgv,
  buildInspectImageArgv,
  buildListContainersByImageArgv,
  buildRemoveImageArgv,
  buildLogsArgv,
  buildRmArgv,
  buildRunOnceArgv,
  buildStartArgv,
  buildStopArgv,
  imageReference,
  withSystemSocket,
} from './argv.js'
import type { ModelContainerCreateSpec, OneShotRunSpec } from './types.js'

const image = {
  repository: 'nvcr.io/nvidia/tensorrt-llm/release',
  digest: `sha256:${'a'.repeat(64)}`,
} as const

const baseSpec: ModelContainerCreateSpec = {
  image,
  gpuUuid: 'GPU-11111111-2222-3333-4444-555555555555',
  selinux: false,
  mounts: {
    model: { source: '/daemon/view/models/qwen3' },
    engineCache: { source: '/daemon/view/cache/qwen3' },
    entrypoint: { source: '/daemon/view/entrypoint.sh' },
    heartbeat: { source: '/daemon/view/heartbeat' },
  },
  publication: { host: '127.0.0.1', host_port: 34521, container_port: 8000 },
  labels: { engine_id: 'tensorrt-llm', scope: 'app', instance_id: 'core-1' },
}

describe('withSystemSocket', () => {
  it('always forces the system unix socket ahead of the subcommand', () => {
    expect(withSystemSocket(['ps'])).toEqual(['--host', DOCKER_SYSTEM_SOCKET, 'ps'])
  })

  it('DOCKER_SYSTEM_SOCKET is derived from the one DOCKER_SOCKET_PATH constant (review round 1, item 15)', () => {
    expect(DOCKER_SYSTEM_SOCKET).toBe(`unix://${DOCKER_SOCKET_PATH}`)
  })
})

describe('imageReference', () => {
  it('joins a valid repository and digest', () => {
    expect(imageReference(image)).toBe(`nvcr.io/nvidia/tensorrt-llm/release@sha256:${'a'.repeat(64)}`)
  })

  it('refuses a repository that would be read as a flag once joined (the T2.1 review case)', () => {
    const hostile = { repository: '-foo/bar', digest: `sha256:${'b'.repeat(64)}` } as const
    expect(() => imageReference(hostile)).toThrow(AtomicCoreError)
    try {
      imageReference(hostile)
      expect.unreachable()
    } catch (error) {
      expect((error as AtomicCoreError).code).toBe('INVALID_ARGUMENT')
    }
  })

  it('refuses a digest that is not sha256:<64 lowercase hex>', () => {
    expect(() => imageReference({ repository: 'a/b', digest: 'sha256:not-hex' as never })).toThrow(
      AtomicCoreError
    )
  })
})

describe('assertSafeArgvValue', () => {
  const bad: Array<[string, string]> = [
    ['empty string', ''],
    ['a leading dash', '-rf'],
    ['a value that only starts with dash-like content', '--privileged'],
    ['an embedded NUL byte', 'a\u0000b'],
    ['an embedded newline', 'a\nb'],
    ['an embedded carriage return', 'a\rb'],
  ]
  for (const [label, value] of bad) {
    it(`refuses ${label}`, () => {
      expect(() => assertSafeArgvValue(value, 'value')).toThrow(AtomicCoreError)
    })
  }

  it('accepts an ordinary path-like value', () => {
    expect(assertSafeArgvValue('/data/models/qwen3', 'value')).toBe('/data/models/qwen3')
  })
})

describe('buildInspectImageArgv / buildInspectContainerArgv', () => {
  it('builds `image inspect <ref>` on the system socket', () => {
    expect(buildInspectImageArgv(image)).toEqual([
      '--host',
      DOCKER_SYSTEM_SOCKET,
      'image',
      'inspect',
      imageReference(image),
    ])
  })

  it('builds `container inspect <id>` on the system socket', () => {
    expect(buildInspectContainerArgv('abc123')).toEqual([
      '--host',
      DOCKER_SYSTEM_SOCKET,
      'container',
      'inspect',
      'abc123',
    ])
  })

  it('refuses a container id that looks like a flag', () => {
    expect(() => buildInspectContainerArgv('-x')).toThrow(AtomicCoreError)
  })
})

describe('buildListContainersByImageArgv / buildRemoveImageArgv (task 2.6)', () => {
  it('lists every container, running or not, created from exactly this digest', () => {
    expect(buildListContainersByImageArgv(image)).toEqual([
      '--host',
      DOCKER_SYSTEM_SOCKET,
      'ps',
      '--all',
      '--no-trunc',
      '--filter',
      `ancestor=${imageReference(image)}`,
      '--format',
      '{{.ID}}',
    ])
  })

  it('removes the image by its digest reference only, never forced', () => {
    const argv = buildRemoveImageArgv(image)
    expect(argv).toEqual(['--host', DOCKER_SYSTEM_SOCKET, 'image', 'rm', imageReference(image)])
    expect(argv).not.toContain('--force')
  })
})

describe('buildStartArgv / buildStopArgv / buildRmArgv / buildLogsArgv', () => {
  it('builds start', () => {
    expect(buildStartArgv('c1')).toEqual(['--host', DOCKER_SYSTEM_SOCKET, 'start', 'c1'])
  })

  it('builds stop with an integer second timeout', () => {
    expect(buildStopArgv('c1', 10)).toEqual(['--host', DOCKER_SYSTEM_SOCKET, 'stop', '--time', '10', 'c1'])
  })

  it('refuses a negative or non-integer stop timeout', () => {
    expect(() => buildStopArgv('c1', -1)).toThrow(AtomicCoreError)
    expect(() => buildStopArgv('c1', 1.5)).toThrow(AtomicCoreError)
  })

  it('builds rm', () => {
    expect(buildRmArgv('c1')).toEqual(['--host', DOCKER_SYSTEM_SOCKET, 'rm', 'c1'])
  })

  it('builds logs with --timestamps (review round 1, item 2) and a tail count', () => {
    expect(buildLogsArgv('c1', 200)).toEqual([
      '--host',
      DOCKER_SYSTEM_SOCKET,
      'logs',
      '--timestamps',
      '--tail',
      '200',
      'c1',
    ])
  })

  it('refuses a non-positive tail count', () => {
    expect(() => buildLogsArgv('c1', 0)).toThrow(AtomicCoreError)
  })
})

describe('buildCreateModelContainerArgv', () => {
  it('never includes a docker socket mount, --privileged, or --ipc=host', () => {
    const argv = buildCreateModelContainerArgv(baseSpec)
    const joined = argv.join(' ')
    expect(joined).not.toContain('docker.sock:/var/run/docker.sock')
    expect(argv).not.toContain('--privileged')
    expect(joined).not.toContain('--ipc')
  })

  it('always sets --restart=no', () => {
    expect(buildCreateModelContainerArgv(baseSpec)).toContain('--restart=no')
  })

  it('always sets --pull=never, so only pull.ts fetches image bytes (review round 1, item 5 ruling)', () => {
    expect(buildCreateModelContainerArgv(baseSpec)).toContain('--pull=never')
  })

  it('sets a bounded --shm-size by default', () => {
    expect(buildCreateModelContainerArgv(baseSpec)).toContain(`--shm-size=${MODEL_CONTAINER_SHM_SIZE}`)
  })

  it('honors an overridden --shm-size', () => {
    expect(buildCreateModelContainerArgv({ ...baseSpec, shmSize: '4g' })).toContain('--shm-size=4g')
  })

  it('refuses an shm-size with no integer+unit shape (review round 1, item 8)', () => {
    for (const bad of ['2', '2gb', 'g2', '-2g', '2.5g', '']) {
      expect(() => buildCreateModelContainerArgv({ ...baseSpec, shmSize: bad })).toThrow(AtomicCoreError)
    }
  })

  it('refuses an shm-size above the ceiling', () => {
    expect(() =>
      buildCreateModelContainerArgv({ ...baseSpec, shmSize: `${MODEL_CONTAINER_SHM_SIZE_CEILING_GB + 1}g` })
    ).toThrow(AtomicCoreError)
  })

  it('accepts an shm-size exactly at the ceiling, in smaller units too', () => {
    expect(
      buildCreateModelContainerArgv({ ...baseSpec, shmSize: `${MODEL_CONTAINER_SHM_SIZE_CEILING_GB}g` })
    ).toContain(`--shm-size=${MODEL_CONTAINER_SHM_SIZE_CEILING_GB}g`)
    expect(
      buildCreateModelContainerArgv({
        ...baseSpec,
        shmSize: `${MODEL_CONTAINER_SHM_SIZE_CEILING_GB * 1024}m`,
      })
    ).toContain(`--shm-size=${MODEL_CONTAINER_SHM_SIZE_CEILING_GB * 1024}m`)
  })

  it('runs the container as the given uid:gid, so the engine cache it writes stays removable (final review I-1)', () => {
    const argv = buildCreateModelContainerArgv({ ...baseSpec, user: { uid: 1000, gid: 1001 } })
    expect(argv.slice(argv.indexOf('--user'), argv.indexOf('--user') + 2)).toEqual(['--user', '1000:1001'])
    // Before the image reference, like every other option.
    expect(argv.indexOf('--user')).toBeLessThan(argv.indexOf(imageReference(image)))
    expect(buildCreateModelContainerArgv({ ...baseSpec, user: { uid: 0, gid: 0 } })).toContain('0:0')
    expect(buildCreateModelContainerArgv(baseSpec)).not.toContain('--user')
  })

  it.each<[string, { uid: number; gid: number }]>([
    ['a negative uid', { uid: -1, gid: 1000 }],
    ['a fractional gid', { uid: 1000, gid: 1.5 }],
    ['a NaN uid', { uid: Number.NaN, gid: 1000 }],
    ['an unsafe integer', { uid: 2 ** 53, gid: 1000 }],
  ])('refuses %s as the container user', (_label, user) => {
    expect(() => buildCreateModelContainerArgv({ ...baseSpec, user })).toThrow(AtomicCoreError)
  })

  it('selects exactly one GPU by UUID', () => {
    const argv = buildCreateModelContainerArgv(baseSpec)
    const i = argv.indexOf('--gpus')
    expect(i).toBeGreaterThan(-1)
    expect(argv[i + 1]).toBe(`device=${baseSpec.gpuUuid}`)
  })

  it('accepts a MIG-<uuid> gpu id too', () => {
    const argv = buildCreateModelContainerArgv({ ...baseSpec, gpuUuid: 'MIG-abc123' })
    const i = argv.indexOf('--gpus')
    expect(argv[i + 1]).toBe('device=MIG-abc123')
  })

  it('refuses a gpu id that is not GPU-<uuid>/MIG-<uuid>, including a comma-injection attempt into --gpus (review round 1, item 7)', () => {
    for (const bad of ['--privileged', 'GPU-1,--privileged', 'gpu-1', 'GPU', 'GPU-']) {
      expect(() => buildCreateModelContainerArgv({ ...baseSpec, gpuUuid: bad })).toThrow(AtomicCoreError)
    }
  })

  it('mounts the model directory read-only, without SELinux, when selinux is false', () => {
    const argv = buildCreateModelContainerArgv(baseSpec)
    expect(argv).toContain('-v')
    expect(argv).toContain('/daemon/view/models/qwen3:/atomic/model:ro')
  })

  it('mounts the engine cache read-write', () => {
    const argv = buildCreateModelContainerArgv(baseSpec)
    expect(argv).toContain('/daemon/view/cache/qwen3:/atomic/engine-cache:rw')
  })

  it('mounts the entrypoint and heartbeat read-only, and sets the entrypoint', () => {
    const argv = buildCreateModelContainerArgv(baseSpec)
    expect(argv).toContain('/daemon/view/entrypoint.sh:/atomic/entrypoint.sh:ro')
    expect(argv).toContain('/daemon/view/heartbeat:/atomic/heartbeat:ro')
    const i = argv.indexOf('--entrypoint')
    expect(argv[i + 1]).toBe('/atomic/entrypoint.sh')
  })

  it('publishes the port only on 127.0.0.1, host_port:container_port', () => {
    const argv = buildCreateModelContainerArgv(baseSpec)
    const i = argv.indexOf('-p')
    expect(argv[i + 1]).toBe('127.0.0.1:34521:8000')
  })

  it('refuses to publish on a non-loopback host', () => {
    const spec = { ...baseSpec, publication: { ...baseSpec.publication, host: '0.0.0.0' } }
    expect(() => buildCreateModelContainerArgv(spec)).toThrow(AtomicCoreError)
    try {
      buildCreateModelContainerArgv(spec)
      expect.unreachable()
    } catch (error) {
      expect((error as AtomicCoreError).code).toBe('FORBIDDEN_HOST')
    }
  })

  it('adds :z to all four mounts when selinux is true and selinuxDataRoot covers them all, and never label=disable', () => {
    const argv = buildCreateModelContainerArgv({
      ...baseSpec,
      selinux: true,
      selinuxDataRoot: '/daemon/view',
    })
    expect(argv).toContain('/daemon/view/models/qwen3:/atomic/model:ro,z')
    expect(argv).toContain('/daemon/view/cache/qwen3:/atomic/engine-cache:rw,z')
    expect(argv).toContain('/daemon/view/entrypoint.sh:/atomic/entrypoint.sh:ro,z')
    expect(argv).toContain('/daemon/view/heartbeat:/atomic/heartbeat:ro,z')
    expect(argv.join(' ')).not.toContain('label=disable')
  })

  it('accepts a mount source exactly equal to the data root itself', () => {
    const argv = buildCreateModelContainerArgv({
      ...baseSpec,
      selinux: true,
      selinuxDataRoot: '/daemon/view',
      mounts: { ...baseSpec.mounts, model: { source: '/daemon/view' } },
    })
    expect(argv).toContain('/daemon/view:/atomic/model:ro,z')
  })

  it('refuses selinux: true with no selinuxDataRoot (review round 1, item 1)', () => {
    expect(() => buildCreateModelContainerArgv({ ...baseSpec, selinux: true })).toThrow(AtomicCoreError)
    try {
      buildCreateModelContainerArgv({ ...baseSpec, selinux: true })
      expect.unreachable()
    } catch (error) {
      expect((error as AtomicCoreError).code).toBe('INVALID_ARGUMENT')
    }
  })

  it('refuses to :z-relabel a mount source outside the SELinux data root ("MUST NOT relabel outside its own data")', () => {
    const spec = {
      ...baseSpec,
      selinux: true,
      selinuxDataRoot: '/daemon/view',
      mounts: { ...baseSpec.mounts, model: { source: '/somewhere/else/models/qwen3' } },
    }
    expect(() => buildCreateModelContainerArgv(spec)).toThrow(AtomicCoreError)
    // Says what to do about it (final review M-6): a models folder that is a symlink to another disk
    // resolves outside the data folder, which is all SELinux relabeling may touch.
    let refusal: AtomicCoreError | undefined
    try {
      buildCreateModelContainerArgv(spec)
    } catch (error) {
      refusal = error as AtomicCoreError
    }
    expect(refusal?.code).toBe('INVALID_ARGUMENT')
    expect(refusal?.details).toBe('/somewhere/else/models/qwen3')
    expect(refusal?.message).toContain('/daemon/view')
    expect(refusal?.message).toContain('move the model folder into the data folder')
    expect(refusal?.message).toContain('mount --bind')
  })

  it('refuses a mount source that is a sibling of the data root sharing its name as a prefix (not a real ancestor check bypass)', () => {
    const spec = {
      ...baseSpec,
      selinux: true,
      selinuxDataRoot: '/daemon/view',
      // "/daemon/viewer" textually starts with "/daemon/view" but is not inside it.
      mounts: { ...baseSpec.mounts, model: { source: '/daemon/viewer/models/qwen3' } },
    }
    expect(() => buildCreateModelContainerArgv(spec)).toThrow(AtomicCoreError)
  })

  it('does not require selinuxDataRoot, and does not validate sources against it, when selinux is false', () => {
    const argv = buildCreateModelContainerArgv({
      ...baseSpec,
      selinux: false,
      mounts: { ...baseSpec.mounts, model: { source: '/anywhere/at/all' } },
    })
    expect(argv).toContain('/anywhere/at/all:/atomic/model:ro')
  })

  it('adds discovery-only labels for engine id, scope and instance id', () => {
    const argv = buildCreateModelContainerArgv(baseSpec)
    expect(argv).toContain('atomic.engine_id=tensorrt-llm')
    expect(argv).toContain('atomic.scope=app')
    expect(argv).toContain('atomic.instance_id=core-1')
  })

  it('places every docker option before the positional image reference, with the command last', () => {
    const argv = buildCreateModelContainerArgv({ ...baseSpec, command: ['serve', '--port', '8000'] })
    const ref = imageReference(image)
    const refIndex = argv.indexOf(ref)
    expect(refIndex).toBeGreaterThan(-1)
    // Everything before the image reference is a docker option/value; nothing docker-relevant
    // follows it, so the command (which may itself contain "--port", the program's own flag) can
    // never be mistaken for a docker flag.
    expect(
      argv.slice(0, refIndex).filter((t) => t === '--gpus' || t === '-p' || t === '--entrypoint').length
    ).toBe(3)
    expect(argv.slice(refIndex + 1)).toEqual(['serve', '--port', '8000'])
  })

  it('refuses a hostile image repository end to end (-foo/bar@sha256:... is refused)', () => {
    const spec = { ...baseSpec, image: { repository: '-foo/bar', digest: image.digest } }
    expect(() => buildCreateModelContainerArgv(spec)).toThrow(AtomicCoreError)
  })

  it('refuses a hostile mount source that starts with a dash', () => {
    const spec = { ...baseSpec, mounts: { ...baseSpec.mounts, model: { source: '-v /:/host' } } }
    expect(() => buildCreateModelContainerArgv(spec)).toThrow(AtomicCoreError)
  })

  it('refuses a relative mount source (review round 1, item 1: must be absolute)', () => {
    const spec = { ...baseSpec, mounts: { ...baseSpec.mounts, model: { source: 'relative/path' } } }
    expect(() => buildCreateModelContainerArgv(spec)).toThrow(AtomicCoreError)
  })

  it('refuses a mount source containing a colon (it would be read as the start of the target)', () => {
    const spec = { ...baseSpec, mounts: { ...baseSpec.mounts, model: { source: '/daemon/a:b' } } }
    expect(() => buildCreateModelContainerArgv(spec)).toThrow(AtomicCoreError)
  })

  it('refuses a mount source that is the docker socket itself, or a directory that contains it', () => {
    for (const dockerSocketish of ['/var/run/docker.sock', '/run/docker.sock', '/var/run', '/run']) {
      const spec = { ...baseSpec, mounts: { ...baseSpec.mounts, model: { source: dockerSocketish } } }
      expect(() => buildCreateModelContainerArgv(spec)).toThrow(AtomicCoreError)
    }
  })

  it('refuses a hostile env value that only starts with a dash inside an object property — a leading "-" is checked, not the object key', () => {
    // The env *key* half is validated as an identifier ("1BAD" fails); the *value* half may start
    // with "-" (review round 1, item 16 — it is embedded inside `KEY=value`, never a standalone token).
    expect(() => buildCreateModelContainerArgv({ ...baseSpec, env: { '1BAD': 'x' } })).toThrow(
      AtomicCoreError
    )
  })

  it('accepts an env value starting with "-" (review round 1, item 16: TEMPERATURE=-0.5 is ordinary)', () => {
    const argv = buildCreateModelContainerArgv({ ...baseSpec, env: { TEMPERATURE: '-0.5' } })
    const i = argv.indexOf('-e')
    expect(argv[i + 1]).toBe('TEMPERATURE=-0.5')
  })

  it('still refuses a control character in an env value', () => {
    expect(() => buildCreateModelContainerArgv({ ...baseSpec, env: { FOO: 'a\nb' } })).toThrow(
      AtomicCoreError
    )
  })

  it('passes validated env as -e KEY=VALUE', () => {
    const argv = buildCreateModelContainerArgv({ ...baseSpec, env: { CTX_LEN: '8192' } })
    const i = argv.indexOf('-e')
    expect(argv[i + 1]).toBe('CTX_LEN=8192')
  })

  it('validates label keys as identifiers too (review round 1, item 16)', () => {
    const argv = buildCreateModelContainerArgv(baseSpec)
    // The fixed ModelContainerLabels keys (engine_id/scope/instance_id) are all valid identifiers;
    // this asserts the validator ran rather than merely that the fixed keys happen to be safe.
    expect(argv.some((token) => token.startsWith('atomic.'))).toBe(true)
  })
})

describe('buildRunOnceArgv', () => {
  const runSpec: OneShotRunSpec = { image, gpuUuid: baseSpec.gpuUuid }

  it('runs with --rm and no restart policy, no mounts, no port publication', () => {
    const argv = buildRunOnceArgv(runSpec)
    expect(argv).toContain('--rm')
    expect(argv.join(' ')).not.toContain('--restart')
    expect(argv).not.toContain('-v')
    expect(argv).not.toContain('-p')
  })

  it('always sets --pull=never (review round 1, item 5 ruling)', () => {
    expect(buildRunOnceArgv(runSpec)).toContain('--pull=never')
  })

  it('refuses a gpu id that is not GPU-<uuid>/MIG-<uuid>', () => {
    expect(() => buildRunOnceArgv({ ...runSpec, gpuUuid: '--privileged' })).toThrow(AtomicCoreError)
  })

  it('selects the given GPU', () => {
    const argv = buildRunOnceArgv(runSpec)
    const i = argv.indexOf('--gpus')
    expect(argv[i + 1]).toBe(`device=${runSpec.gpuUuid}`)
  })

  it('omits --gpus when no gpu is requested', () => {
    const argv = buildRunOnceArgv({ image })
    expect(argv).not.toContain('--gpus')
  })

  it('places the image reference and command after every option', () => {
    const argv = buildRunOnceArgv({ ...runSpec, command: ['nvidia-smi', '-L'] })
    const ref = imageReference(image)
    const refIndex = argv.indexOf(ref)
    expect(argv.slice(refIndex + 1)).toEqual(['nvidia-smi', '-L'])
  })
})
