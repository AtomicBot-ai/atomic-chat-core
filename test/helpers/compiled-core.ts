/**
 * Driving the compiled `atomic-chat-core` binary from e2e tests: start a daemon on a data folder,
 * talk to its control API, and lay out models and a fake `llama-server` for it to load.
 *
 * Nothing here imports from `src/`, so a packaging change that breaks the binary cannot pass by
 * type-checking alone.
 */
import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const TRIPLE =
  process.platform === 'darwin'
    ? process.arch === 'arm64'
      ? 'aarch64-apple-darwin'
      : 'x86_64-apple-darwin'
    : process.platform === 'win32'
      ? 'x86_64-pc-windows-msvc.exe'
      : 'x86_64-unknown-linux-gnu'
export const BIN = join(ROOT, 'dist/bin', `atomic-chat-core-${TRIPLE}`)
export const APP_BIN = join(ROOT, 'dist/bin', `atomic-chat-app-core-${TRIPLE}`)
export const FAKE_LLAMA = join(ROOT, 'test/helpers/fake-llama-server.mjs')

export interface ReadyLine {
  event: string
  pid: number
  instance_id: string
  protocol: number
  version: string
  control_host: string
  control_port: number
}

export const runCli = (dataFolder: string, args: string[]) =>
  spawnSync(BIN, [...args, '--data-folder', dataFolder], { encoding: 'utf8', timeout: 30_000 })

export const runCliAsync = (dataFolder: string, args: string[]) =>
  new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(BIN, [...args, '--data-folder', dataFolder], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    child.once('error', reject)
    child.once('exit', (status) => resolve({ status, stdout, stderr }))
  })

/** Start `daemon` and wait for the ready line it prints on stdout. The child is added to `daemons`. */
export async function startDaemon(
  dataFolder: string,
  daemons: ChildProcess[],
  extra: string[] = [],
  env: NodeJS.ProcessEnv = {},
  binary = BIN
): Promise<{ ready: ReadyLine; child: ChildProcess }> {
  const child = spawn(binary, ['daemon', '--data-folder', dataFolder, '--control-port', '0', ...extra], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  })
  daemons.push(child)
  let stdout = ''
  let stderr = ''
  child.stderr?.on('data', (c: Buffer) => (stderr += c.toString()))
  const ready = await new Promise<ReadyLine>((resolve, reject) => {
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      const line = stdout.split('\n')[0]
      if (line && stdout.includes('\n')) {
        try {
          resolve(JSON.parse(line) as ReadyLine)
        } catch (e) {
          reject(new Error(`ready line is not JSON: ${line} (${(e as Error).message})`))
        }
      }
    })
    child.once('exit', (code) => reject(new Error(`daemon exited with ${code}\n${stderr}`)))
    setTimeout(() => reject(new Error(`no ready line in 20s\n${stderr}`)), 20_000).unref()
  })
  return { ready, child }
}

export const controlToken = (dataFolder: string) =>
  readFileSync(join(dataFolder, 'atomic-core', 'control-token'), 'utf8').trim()

export const control = (dataFolder: string, ready: ReadyLine, path: string, init: RequestInit = {}) =>
  fetch(`http://${ready.control_host}:${ready.control_port}/atomic/v1${path}`, {
    ...init,
    headers: { authorization: `Bearer ${controlToken(dataFolder)}`, ...(init.headers ?? {}) },
  })

export async function writeModel(dataFolder: string, id: string): Promise<void> {
  const dir = join(dataFolder, 'llamacpp', 'models', ...id.split('/'))
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'model.gguf'), Buffer.alloc(64, 0x47))
  await writeFile(
    join(dir, 'model.yml'),
    `model_path: llamacpp/models/${id}/model.gguf\nname: ${id}\nsize_bytes: 64\nmodel_size_bytes: 64\n`
  )
}

/**
 * A backend pack whose `llama-server` is the fake one, so the binary can actually load something.
 * `env` is exported to the fake (`FAKE_LLAMA_*`, see `fake-llama-server.mjs`).
 */
export async function writeFakeBackend(dataFolder: string, env: Record<string, string> = {}): Promise<void> {
  const backend =
    process.platform === 'linux' ? 'linux-cpu-x64' : `macos-${process.arch === 'arm64' ? 'arm64' : 'x64'}`
  const dir = join(dataFolder, 'llamacpp-upstream', 'backends', 'b6325', backend, 'build', 'bin')
  await mkdir(dir, { recursive: true })
  const exe = join(dir, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server')
  const exports = Object.entries(env)
    .map(([name, value]) => `export ${name}=${JSON.stringify(value)}\n`)
    .join('')
  await writeFile(
    exe,
    `#!/bin/sh\n${exports}exec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_LLAMA)} "$@"\n`,
    { mode: 0o755 }
  )
}
