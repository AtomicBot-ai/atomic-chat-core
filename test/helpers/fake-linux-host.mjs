#!/usr/bin/env node
/**
 * A whole Linux machine for the managed-runtime tests (task 2.6), described by one JSON state file:
 * which driver and GPUs it has, whether Docker is installed, running and reachable by this user,
 * whether the NVIDIA toolkit and runtime are there, whether the user is in the `docker` group and
 * whether this session has it yet, whether a GPU is visible inside a container, and which images
 * and containers Docker holds.
 *
 * `answer(state, command, args)` is the pure part, imported by unit tests. Run as a program
 * (`node fake-linux-host.mjs <state.json> <command> ...args`, wrapped by one `bin/<command>` shell
 * script per command in an `ATOMIC_MANAGED_TEST_HOST` folder), it answers like the real command,
 * appends the call to `<state.json>.calls`, and applies the few state changes docker itself makes
 * (`image rm`). Nothing here runs a real docker, package manager or GPU tool.
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'

/**
 * What real Docker writes in `RepoDigests` for a reference it pulled: a Docker Hub image without its
 * registry (`docker.io/vllm/vllm-openai@…` → `vllm/vllm-openai@…`, `docker.io/library/ubuntu@…` →
 * `ubuntu@…`); every other registry as it was named.
 */
function reportedRepoDigest(ref) {
  const short = ref.replace(/^(?:docker\.io|index\.docker\.io|registry-1\.docker\.io)\//, '')
  if (short === ref) return ref
  return short.replace(/^library\/(?=[^/]+@)/, '')
}

const SOCKET = 'unix:///var/run/docker.sock'

const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' })
const fail = (code, stderr, stdout = '') => ({ code, stdout, stderr })
const notFound = (command) => fail(127, `${command}: command not found\n`)

function dockerInfo(state) {
  const docker = state.docker
  if (!docker.reachable) {
    const why = docker.service_active
      ? 'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock'
      : 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?'
    const stdout = JSON.stringify({
      ID: '',
      ContainersRunning: 0,
      DockerRootDir: '',
      Runtimes: null,
      SecurityOptions: null,
      CDISpecDirs: null,
      ServerErrors: [why],
    })
    return fail(1, `${why}\n`, `${stdout}\n`)
  }
  const runtimes = { runc: { path: 'runc' } }
  if (docker.gpu_runtime) runtimes.nvidia = { path: '/usr/bin/nvidia-container-runtime' }
  return ok(
    `${JSON.stringify({
      ID: 'FAKE:DAEMON',
      ContainersRunning: docker.containers_running ?? 0,
      ServerVersion: '28.3.0',
      DockerRootDir: docker.root_dir ?? '/var/lib/docker',
      Runtimes: runtimes,
      CDISpecDirs: ['/etc/cdi', '/var/run/cdi'],
      SecurityOptions: docker.selinux
        ? ['name=seccomp,profile=default', 'name=selinux']
        : ['name=seccomp,profile=default'],
      ServerErrors: [],
    })}\n`
  )
}

/** The docker CLI, with or without the forced system socket the executor always passes. */
function docker(state, args) {
  if (!state.docker.installed) return notFound('docker')
  if (args[0] === '--version') return ok('Docker version 28.3.0, build afdd53b\n')
  const [flag, socket, ...rest] = args
  if ((flag !== '-H' && flag !== '--host') || socket !== SOCKET)
    return fail(2, `fake docker: unexpected ${args.join(' ')}\n`)
  if (rest[0] === 'info') return dockerInfo(state)
  if (!state.docker.reachable)
    return fail(1, 'permission denied while trying to connect to the Docker daemon socket\n')
  const images = state.images ?? []
  const containers = state.containers ?? []
  switch (rest[0]) {
    case 'run': {
      const gpu = rest[rest.indexOf('--gpus') + 1]?.replace(/^device=/, '')
      if (!state.gpu_visible_in_container) {
        return fail(
          125,
          'docker: Error response from daemon: could not select device driver "" with capabilities: [[gpu]].\n'
        )
      }
      return ok(`${gpu}\n`)
    }
    case 'image': {
      const ref = rest[2]
      if (rest[1] === 'inspect') {
        return images.includes(ref)
          ? ok(`${JSON.stringify([{ Id: 'sha256:fake', RepoDigests: [reportedRepoDigest(ref)] }])}\n`)
          : fail(1, `Error: No such image: ${ref}\n`, '[]\n')
      }
      if (rest[1] === 'rm') {
        if (!images.includes(ref)) return fail(1, `Error response from daemon: No such image: ${ref}\n`)
        if (containers.some((c) => c.image === ref))
          return fail(1, 'Error response from daemon: conflict: image is being used\n')
        return { ...ok(`Untagged: ${ref}\n`), next: { ...state, images: images.filter((i) => i !== ref) } }
      }
      break
    }
    case 'ps': {
      const filter = rest[rest.indexOf('--filter') + 1] ?? ''
      const ref = filter.replace(/^ancestor=/, '')
      return ok(
        containers
          .filter((c) => c.image === ref)
          .map((c) => `${c.id}\n`)
          .join('')
      )
    }
    case 'container': {
      const found = containers.find((c) => c.id === rest[2])
      return found
        ? ok(`${JSON.stringify([{ Id: found.id, State: { Running: found.running ?? true } }])}\n`)
        : fail(1, `Error: No such container: ${rest[2]}\n`, '[]\n')
    }
    case 'stop': {
      const id = rest.at(-1)
      if (!containers.some((c) => c.id === id))
        return fail(1, `Error response from daemon: No such container: ${id}\n`)
      if ((state.stop_refusals ?? 0) > 0) {
        // A stop Docker does not confirm: what keeps a container, and its GPU, held.
        return {
          ...fail(
            1,
            'Error response from daemon: cannot stop container: tried to kill container, but did not receive an exit event\n'
          ),
          next: { ...state, stop_refusals: state.stop_refusals - 1 },
        }
      }
      return {
        ...ok(`${id}\n`),
        next: { ...state, containers: containers.map((c) => (c.id === id ? { ...c, running: false } : c)) },
      }
    }
    case 'rm': {
      const id = rest.at(-1)
      return { ...ok(`${id}\n`), next: { ...state, containers: containers.filter((c) => c.id !== id) } }
    }
  }
  return fail(2, `fake docker: unexpected ${rest.join(' ')}\n`)
}

/** What `command args` prints on the machine `state` describes. `next` is the state after it, if changed. */
export function answer(state, command, args) {
  const user = state.user ?? userInfo().username
  switch (command) {
    case 'uname':
      return ok(`${state.arch ?? 'x86_64'}\n`)
    case 'nvidia-smi': {
      if (!state.driver) return notFound('nvidia-smi')
      return ok(
        (state.gpus ?? [])
          .map((g) => `${g.uuid}, ${g.name}, ${g.cc}, ${g.total_mib}, ${g.free_mib}, ${state.driver}\n`)
          .join('')
      )
    }
    case 'docker':
      return docker(state, args)
    case 'nvidia-ctk':
      // `-base` alone ships nvidia-ctk too (task 2.23, F-5).
      if (!state.toolkit && !state.toolkit_base) return notFound('nvidia-ctk')
      if (args[0] === '--version') return ok('NVIDIA Container Toolkit CLI version 1.17.4\n')
      // `cdi list`: a device only once the spec exists — by default wherever the runtime is set up.
      return (state.cdi ?? state.docker.gpu_runtime)
        ? ok('INFO[0000] Found 1 CDI devices\nnvidia.com/gpu=all\n')
        : ok('INFO[0000] Found 0 CDI devices\n')
    case 'dpkg-query':
      // The full toolkit is its own single-package query (F-5); `-base` never answers for it.
      if (args.includes('nvidia-container-toolkit'))
        return state.toolkit
          ? ok('ii  nvidia-container-toolkit\n')
          : fail(1, 'dpkg-query: no packages found matching nvidia-container-toolkit\n')
      return state.docker.installed
        ? fail(1, '', 'ii  docker-ce\n')
        : fail(1, 'dpkg-query: no packages found matching docker-ce\n')
    case 'rpm':
    case 'pacman':
      return notFound(command)
    case 'snap':
      return fail(1, 'error: no matching snaps installed\n')
    case 'id':
      return ok(`${user} adm sudo${state.group?.effective ? ' docker' : ''}\n`)
    case 'getent':
      return state.group?.configured ? ok(`docker:x:999:${user}\n`) : fail(2, '')
    case 'systemctl':
      return state.docker.service_active ? ok('active\n') : fail(3, '', 'inactive\n')
  }
  return notFound(command)
}

// Run as a program: `fake-linux-host.mjs <state.json> <command> ...args`.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const [statePath, command, ...args] = process.argv.slice(2)
  const state = JSON.parse(readFileSync(statePath, 'utf8'))
  appendFileSync(`${statePath}.calls`, `${JSON.stringify([command, ...args])}\n`)
  const result = answer(state, command, args)
  if (result.next) writeFileSync(statePath, JSON.stringify(result.next, null, 2))
  process.stdout.write(result.stdout)
  process.stderr.write(result.stderr)
  process.exit(result.code)
}
