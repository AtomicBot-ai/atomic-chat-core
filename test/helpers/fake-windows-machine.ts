/**
 * A Windows 11 PC for the compiled core's managed e2e (change `add-tensorrt-llm-windows`, task 2.10):
 * the folder `ATOMIC_MANAGED_TEST_WINDOWS` names (see `src/runtime/environment/windows-host.ts`), with
 * the machine in `windows.json`, `wsl.exe` as `fake-wsl.mjs` run by this very Node with its state in
 * `wsl/`, and conf main faked over HTTPS with the test CA: the Windows manifest, whose rootfs is served
 * here too (its sha256 matching the bytes), so the import downloads and checks a real file.
 * `enableWsl` is the elevated executor the app runs through UAC: it installs WSL and leaves it needing
 * a restart; `reboot` is the restart.
 *
 * Nothing here imports from `src/`: the e2e suite drives the binary only through its routes.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import https from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FakeWslState } from './fake-wsl.mjs'

const FAKE_WSL = fileURLToPath(new URL('./fake-wsl.mjs', import.meta.url))
const tls = (name: string): string => fileURLToPath(new URL(`../fixtures/tls/${name}`, import.meta.url))
export const DESCRIPTOR_URL = new URL('../fixtures/runtimes/tensorrt-llm-1.2.1-r2.json', import.meta.url).href
const DESCRIPTOR = JSON.parse(readFileSync(fileURLToPath(DESCRIPTOR_URL), 'utf8')) as {
  descriptor_id: string
  image: Record<string, { repository: string; digest: string }>
}
export const DESCRIPTOR_ID = DESCRIPTOR.descriptor_id
export const ENGINE_IMAGE = `${DESCRIPTOR.image['linux/amd64']!.repository}@${DESCRIPTOR.image['linux/amd64']!.digest}`
const WINDOWS_MANIFEST = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../fixtures/runtimes/environments/windows.json', import.meta.url)),
    'utf8'
  )
) as Record<string, unknown> & { rootfs: Record<string, unknown> }
const OS_RELEASE = readFileSync(
  fileURLToPath(new URL('../fixtures/linux-probe/os-release/ubuntu-24.04.txt', import.meta.url)),
  'utf8'
)
export const GPU_UUID = 'GPU-1c6a2b3c-0000-4000-8000-000000000001'
const ROOTFS = Buffer.from('a stand-in for ubuntu-24.04.5-wsl-amd64.wsl')
export const WINDOWS_MANIFEST_PATH = '/runtimes/environments/windows.json'

export interface WindowsMachineState {
  machine: string
  release: string
  elevated: boolean
  virtualization: { firmware: boolean | null; hypervisor: boolean } | 'unreadable'
  nvidia: {
    driver: string
    gpus: { uuid: string; name: string; cc: string; total_mib: number; free_mib: number }[]
  } | null
  wslconfig: string | null
  volume_free_bytes: number | null
  vhdx_bytes: number | null
}

export interface FakeWindowsMachine {
  dir: string
  env: Record<string, string>
  windows(): WindowsMachineState
  setWindows(change: (state: WindowsMachineState) => WindowsMachineState): void
  wsl(): FakeWslState
  setWsl(change: (state: FakeWslState) => FakeWslState): void
  /** Every `wsl.exe` argv, oldest first. */
  wslCalls(): string[][]
  /** The elevated executor the app runs through UAC (`windows.enable-wsl`): WSL in, a restart needed. */
  enableWsl(): void
  /** Windows restarted: WSL starts VMs now. */
  reboot(): void
  /** `wsl --shutdown` from a terminal: every hold ends, the VM with what ran in it. */
  shutdown(): void
  /** WSL may start the VM again (after `shutdown`). */
  bootable(): void
  close(): Promise<void>
}

/** What a freshly imported Ubuntu 24.04 rootfs is: systemd, the NVIDIA libraries WSL provides, nothing else. */
const importedGuest = () => ({
  files: {
    '/etc/os-release': OS_RELEASE,
    '/proc/meminfo': 'MemTotal:       32000000 kB\nMemAvailable:   30000000 kB\n',
  },
  dirs: ['/', '/var', '/var/lib', '/var/lib/docker', '/run/systemd/system'],
  users: [],
  free_disk_bytes: 900_000_000_000,
  nvml_version: '590.48.01',
  host: {
    user: 'root',
    driver: '591.44',
    gpus: [{ uuid: GPU_UUID, name: 'NVIDIA GeForce RTX 4090', cc: '8.9', total_mib: 24564, free_mib: 24000 }],
    docker: { installed: false, reachable: false, service_active: false, gpu_runtime: false },
    toolkit: false,
    cdi: false,
    gpu_visible_in_container: true,
    images: [],
    containers: [],
  },
})

/** A Windows 11 desktop with an RTX 4090 and its driver; WSL as `wsl` says. */
export async function fakeWindowsMachine(wsl: FakeWslState): Promise<FakeWindowsMachine> {
  const dir = await mkdtemp(join(tmpdir(), 'awm-'))
  const wslDir = join(dir, 'wsl')
  await mkdir(wslDir, { recursive: true })
  await mkdir(join(dir, 'local-app-data'), { recursive: true })
  await mkdir(join(dir, 'guest-fs'), { recursive: true })
  const windowsPath = join(dir, 'windows.json')
  const statePath = join(wslDir, 'state.json')
  const write = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value, null, 2))
  write(windowsPath, {
    machine: 'x86_64',
    release: '10.0.22631',
    elevated: false,
    virtualization: { firmware: true, hypervisor: false },
    nvidia: {
      driver: '591.44',
      gpus: [
        { uuid: GPU_UUID, name: 'NVIDIA GeForce RTX 4090', cc: '8.9', total_mib: 24564, free_mib: 24000 },
      ],
    },
    wslconfig: null,
    volume_free_bytes: 500_000_000_000,
    vhdx_bytes: 30_000_000_000,
  } satisfies WindowsMachineState)
  write(statePath, { ...wsl, import_guest: importedGuest(), model_docker: join(dir, 'docker.json') })
  write(join(dir, 'wsl-command.json'), [process.execPath, FAKE_WSL, wslDir])

  const server = https.createServer(
    { key: readFileSync(tls('server.key')), cert: readFileSync(tls('server.pem')) },
    (req, res) => {
      const path = new URL(req.url ?? '/', 'https://conf').pathname
      if (path === '/rootfs.wsl') return res.end(ROOTFS)
      if (path === WINDOWS_MANIFEST_PATH) {
        res.setHeader('content-type', 'application/json')
        return res.end(JSON.stringify(manifest))
      }
      res.statusCode = 404
      res.end('404: Not Found')
    }
  )
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const manifest = {
    ...WINDOWS_MANIFEST,
    rootfs: {
      ...WINDOWS_MANIFEST.rootfs,
      url: `https://127.0.0.1:${port}/rootfs.wsl`,
      sha256: createHash('sha256').update(ROOTFS).digest('hex'),
    },
  }

  const readWsl = (): FakeWslState => JSON.parse(readFileSync(statePath, 'utf8')) as FakeWslState
  return {
    dir,
    env: {
      ATOMIC_MANAGED_TEST_WINDOWS: dir,
      ATOMIC_RUNTIME_DESCRIPTOR_URL: DESCRIPTOR_URL,
      ATOMIC_ENVIRONMENT_MANIFEST_URL: `https://127.0.0.1:${port}${WINDOWS_MANIFEST_PATH}`,
      NODE_EXTRA_CA_CERTS: tls('ca.pem'),
    },
    windows: () => JSON.parse(readFileSync(windowsPath, 'utf8')) as WindowsMachineState,
    setWindows: (change) =>
      write(windowsPath, change(JSON.parse(readFileSync(windowsPath, 'utf8')) as WindowsMachineState)),
    wsl: readWsl,
    setWsl: (change) => write(statePath, change(readWsl())),
    wslCalls: () => {
      const path = join(wslDir, 'calls.jsonl')
      return existsSync(path)
        ? readFileSync(path, 'utf8')
            .trim()
            .split('\n')
            .map((line) => (JSON.parse(line) as { argv: string[] }).argv)
        : []
    },
    enableWsl: () =>
      write(statePath, { ...readWsl(), installed: true, wsl_version: '2.4.4.0', ready: false }),
    reboot: () => write(statePath, { ...readWsl(), ready: true }),
    shutdown: () => writeFileSync(join(wslDir, 'stopped'), ''),
    bootable: () => rmSync(join(wslDir, 'stopped'), { force: true }),
    close: async () => {
      // Holds a killed core left behind end on this, the way `wsl --shutdown` ends them.
      writeFileSync(join(wslDir, 'stopped'), '')
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await new Promise((resolve) => setTimeout(resolve, 100))
      await rm(dir, { recursive: true, force: true, maxRetries: 3 })
    },
  }
}
