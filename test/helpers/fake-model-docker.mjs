#!/usr/bin/env node
/**
 * A stand-in `docker` CLI for the `tensorrt-llm` provider e2e (`test/e2e/tensorrt-llm-provider.test.ts`):
 * enough of `create`/`start`/`container inspect`/`logs`/`stop`/`rm`/`info` for the managed-text
 * lifecycle, and `ps`/`image rm` for removing the engine, with a container table in a JSON file.
 * `start` spawns `fake-model-engine.mjs` on the host port `docker create` was given, standing in for
 * `trtllm-serve` behind the container's published port — so a request through the session gateway
 * really reaches "the container", and a stop really ends it. A model mounted from a directory whose name contains `slow` never becomes healthy;
 * one whose name contains `stuck` never stops: `docker stop` fails the way a daemon that timed out
 * does, and the container keeps running (GPU residency's "Контейнер не останавливается").
 *
 *   FAKE_DOCKER_STATE  the JSON file holding the container table (required)
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const statePath = process.env.FAKE_DOCKER_STATE
const ENGINE = fileURLToPath(new URL('./fake-model-engine.mjs', import.meta.url))
const db = existsSync(statePath)
  ? JSON.parse(readFileSync(statePath, 'utf8'))
  : { n: 0, containers: {}, calls: [] }
const save = () => {
  writeFileSync(`${statePath}.tmp`, JSON.stringify(db))
  renameSync(`${statePath}.tmp`, statePath)
}
// Every command the executor builds starts with `--host unix:///var/run/docker.sock`.
const args = process.argv.slice(2)
if (args[0] === '--host') args.splice(0, 2)
const sub = args[0]
db.calls.push(sub === 'container' ? `container ${args[1]}` : sub)
const id = args[args.length - 1]
const c = db.containers[id]
const stamp = (line) => `${new Date().toISOString().replace('Z', '000000Z')} ${line}`
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const done = (code = 0) => {
  save()
  process.exit(code)
}

if (sub === 'info') {
  console.log(JSON.stringify({ ServerVersion: '28.1.1', SecurityOptions: ['name=seccomp,profile=builtin'] }))
  done()
}
if (sub === 'create') {
  const [, hostPort] = args[args.indexOf('-p') + 1].split(':')
  const model = args.find((a) => a.endsWith(':/atomic/model:ro')) ?? ''
  const gpus = args[args.indexOf('--gpus') + 1]
  const newId = `fakectr${String(++db.n).padStart(8, '0')}`
  db.containers[newId] = {
    status: 'created',
    hostPort: Number(hostPort),
    slow: /slow/.test(model),
    stuck: /stuck/.test(model),
    gpus,
    pid: null,
    exitCode: 0,
    logs: [],
  }
  console.log(newId)
  done()
}
// What a removal of the engine asks (task 2.6): which containers still use an image — none, once
// every model container is gone (this fake runs nothing else) — and removing it by digest.
if (sub === 'ps') {
  const live = Object.keys(db.containers)
  if (live.length > 0) console.log(live.join('\n'))
  done()
}
if (sub === 'image' && args[1] === 'rm') {
  db.images_removed = [...(db.images_removed ?? []), args[2]]
  console.log(`Untagged: ${args[2]}`)
  done()
}
if (!c) {
  console.error(`Error response from daemon: No such container: ${id}`)
  done(1)
}
if (sub === 'start') {
  const child = spawn(process.execPath, [ENGINE, String(c.hostPort), c.slow ? 'slow' : 'ready'], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  c.pid = child.pid
  c.status = 'running'
  c.logs.push(stamp('[TRT-LLM] fake engine starting'), stamp('Loading safetensors weights in parallel'))
  console.log(id)
  done()
}
if (sub === 'container' && args[1] === 'inspect') {
  if (c.status === 'running' && !alive(c.pid)) {
    c.status = 'exited'
    c.exitCode = 137
  }
  const state = { Status: c.status, Running: c.status === 'running', ExitCode: c.exitCode }
  console.log(JSON.stringify([{ Id: id, State: state }]))
  done()
}
if (sub === 'logs') {
  if (c.logs.length > 0) console.log(c.logs.join('\n'))
  done()
}
if (sub === 'stop') {
  if (c.stuck) {
    console.error(`Error response from daemon: cannot stop container: ${id}: context deadline exceeded`)
    done(1)
  }
  if (c.pid && alive(c.pid)) process.kill(c.pid, 'SIGKILL')
  c.status = 'exited'
  console.log(id)
  done()
}
if (sub === 'rm') {
  delete db.containers[id]
  console.log(id)
  done()
}
console.error(`fake docker: unsupported ${args.join(' ')}`)
done(1)
