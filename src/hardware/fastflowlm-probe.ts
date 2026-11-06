import { access, constants } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { posix, win32 } from 'node:path'
import type { FastFlowLmAccelerators, FastFlowLmNpu } from '../contracts/index.js'
import type { ProbeDeps, ToolResult } from './probe-common.js'
import { PROBE_POWERSHELL_TIMEOUT_MS } from './probe-common.js'

type Report = FastFlowLmAccelerators
interface Options {
  supported: boolean
  build: { tag: string; dir: string } | null
  desktop?: boolean
  account?: () => { name: string; uid: number | undefined }
  deviceAccess?: (file: string) => Promise<boolean>
}

const pciRoot = '/sys/bus/pci/devices'
const bdfPattern = /^[0-9a-f]{4}:[0-9a-f]{2}:[01][0-9a-f]\.[0-7]$/i
// The effective limit used for the qualified Qwen3 run. FLM's validation alone accepts 100 MiB.
const requiredMemlock = String(2 ** 31)
const windowsDriver = '32.0.203.304'

function device(id: string, pci: string, revision: string): FastFlowLmNpu {
  return {
    id,
    pci_device_id: '1022:' + pci,
    bdf: null,
    pnp_hardware_id: null,
    generation:
      pci === '1502' ? 'xdna1' : pci === '17f0' && ['10', '11', '20'].includes(revision) ? 'xdna2' : null,
    driver: 'unknown',
    driver_version: null,
    firmware: null,
    node: null,
    accessible: null,
    xrt_visible: null,
    ready: false,
  }
}

async function linuxDevices(deps: ProbeDeps, options: Options) {
  const { fs } = deps
  const rows = await Promise.all(
    (await fs.readdir(pciRoot))
      .filter((id) => bdfPattern.test(id))
      .map(async (id) => {
        const root = pciRoot + '/' + id
        const read = async (name: string) => (await fs.readFile(root + '/' + name)).trim().toLowerCase()
        if ((await read('vendor')) !== '0x1022') return null
        const pci = await read('device')
        if (!['0x1502', '0x17f0'].includes(pci)) return null
        const revision = (await read('revision')).slice(2)
        const row = device(id, pci.slice(2), revision)
        row.pci_revision = revision
        row.bdf = id.toLowerCase()
        try {
          row.driver = posix.basename(await fs.readlink(root + '/driver')) === 'amdxdna' ? 'bound' : 'problem'
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') row.driver = 'missing'
        }
        const nodes = (await fs.readdir(root + '/accel').catch(() => [])).filter((name) =>
          /^accel\d+$/.test(name)
        )
        if (nodes.length === 1) {
          row.node = '/dev/accel/' + nodes[0]
          const canAccess =
            options.deviceAccess ??
            (async (path: string) => {
              await access(path, constants.R_OK | constants.W_OK)
              return true
            })
          row.accessible = await canAccess(row.node).catch((error: NodeJS.ErrnoException) =>
            error.code === 'EACCES' ? false : null
          )
        }
        return row
      })
  )
  return rows.filter((row): row is FastFlowLmNpu => row !== null)
}

function linuxMode(cgroup: string, report: Report, desktop: boolean) {
  // cgroup v2 and the v1 name=systemd hierarchy carry the launch unit.
  const hierarchy = cgroup.split('\n').find((line) => /^(0::|\d+:name=systemd:)\//.test(line))
  if (!hierarchy) return
  const path = hierarchy.slice(hierarchy.lastIndexOf(':') + 1).split('/')
  const unit = path.findLast((part) => part.endsWith('.scope') || part.endsWith('.service'))
  if (
    unit?.endsWith('.service') &&
    !/^user@\d+\.service$/.test(unit) &&
    !/^ssh(d)?(@.*)?\.service$/.test(unit)
  ) {
    report.runtime_service = unit
    report.runtime_mode = path.some((part) => /^user@\d+\.service$/.test(part))
      ? 'user-service'
      : 'system-service'
  } else if (desktop) {
    report.runtime_mode = 'desktop'
  } else if (unit && (/^session-[^/]+\.scope$/.test(unit) || /^ssh(d)?(@.*)?\.service$/.test(unit))) {
    report.runtime_mode = 'interactive'
  }
}

const windowsQuery = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$service = $null
$session = (Get-Process -Id $PID).SessionId
if ($session -eq 0) {
  $ancestor = (Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId
  $services = @(Get-CimInstance Win32_Service -Filter 'State="Running"')
  for ($i = 0; $ancestor -and $i -lt 12; $i++) {
    $match = $services | Where-Object { $_.ProcessId -eq $ancestor } | Select-Object -First 1
    if ($match) { $service = $match.Name; break }
    $ancestor = (Get-CimInstance Win32_Process -Filter "ProcessId=$ancestor").ParentProcessId
  }
}
$rows = @(Get-CimInstance Win32_PnPEntity -Filter "Present=True AND (DeviceID LIKE 'PCI%VEN_1022&DEV_17F0%' OR DeviceID LIKE 'PCI%VEN_1022&DEV_1502%')" | ForEach-Object {
  $id = $_.PNPDeviceID
  $hardware = @($_.HardwareID)
  $problem = $_.ConfigManagerErrorCode
  $props = @(Get-PnpDeviceProperty -InstanceId $id -KeyName DEVPKEY_Device_DriverVersion,DEVPKEY_Device_BusNumber,DEVPKEY_Device_Address -ErrorAction SilentlyContinue)
  $version = ($props | Where-Object KeyName -eq DEVPKEY_Device_DriverVersion).Data
  $bus = ($props | Where-Object KeyName -eq DEVPKEY_Device_BusNumber).Data
  $addr = ($props | Where-Object KeyName -eq DEVPKEY_Device_Address).Data
  $bdf = $null
  if ($null -ne $bus -and $null -ne $addr) { $bdf = '0000:{0:x2}:{1:x2}.{2:x}' -f $bus,($addr -shr 16),($addr -band 65535) }
  @{ id=$id; hardware=$hardware; problem=$problem; version=$version; bdf=$bdf }
})
@{account=$identity.Name; elevated=$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator); service=$service; session=$session; devices=$rows} | ConvertTo-Json -Depth 4 -Compress
`

function parseOutput(result: ToolResult) {
  if (result.code !== 0) throw Error('probe failed')
  return JSON.parse(result.stdout.trim())
}

async function windowsFacts(deps: ProbeDeps, report: Report, desktop: boolean) {
  const system = win32.join(deps.env.SystemRoot ?? 'C:\\Windows', 'System32')
  const facts = parseOutput(
    await deps.run(
      win32.join(system, 'WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', windowsQuery],
      PROBE_POWERSHELL_TIMEOUT_MS
    )
  )
  if (typeof facts.account === 'string' && facts.account) report.runtime_account = facts.account
  if (facts.elevated !== false)
    report.blockers.push(facts.elevated === true ? 'privileged-account' : 'account-unknown')
  if (typeof facts.service === 'string' && facts.service && facts.service.toLowerCase() !== 'sshd') {
    report.runtime_mode = 'system-service'
    report.runtime_service = facts.service
  } else if (
    (Number.isInteger(facts.session) && facts.session > 0) ||
    facts.service?.toLowerCase() === 'sshd'
  ) {
    report.runtime_mode = desktop ? 'desktop' : 'interactive'
  }
  if (!Array.isArray(facts.devices)) throw Error('missing device inventory')
  for (const item of facts.devices) {
    const instance = typeof item.id === 'string' && /^PCI\\VEN_1022&DEV_(17F0|1502)\b(?=&|\\)/i.exec(item.id)
    if (!instance) throw Error('unrecognized PCI instance ID')
    const ids: string[] = [
      item.id.split('\\', 2).join('\\'),
      ...(Array.isArray(item.hardware) ? item.hardware : []),
    ]
    const prefix = 'PCI\\VEN_1022&DEV_' + instance[1]!.toUpperCase() + '&'
    const candidates = ids
      .filter((id) => typeof id === 'string' && id.toUpperCase().startsWith(prefix))
      .map((id) => id.toUpperCase())
    const hardware =
      candidates.find((id) => /&SUBSYS_[0-9A-F]{8}&REV_[0-9A-F]{2}$/.test(id)) ??
      candidates.find((id) => /&REV_[0-9A-F]{2}$/.test(id))
    const row = device(item.id, instance[1]!.toLowerCase(), hardware?.slice(-2).toLowerCase() ?? '')
    row.pnp_hardware_id = hardware ?? null
    row.driver =
      item.problem === 28
        ? 'missing'
        : item.problem === 0
          ? 'bound'
          : Number.isInteger(item.problem)
            ? 'problem'
            : 'unknown'
    if (typeof item.version === 'string' && /^\d+(\.\d+){3}$/.test(item.version))
      row.driver_version = item.version
    if (typeof item.bdf === 'string' && bdfPattern.test(item.bdf)) row.bdf = item.bdf.toLowerCase()
    report.devices.push(row)
  }
}

function windowsVersionOK(version: string) {
  const actual = version.split('.').map(Number)
  const required = windowsDriver.split('.').map(Number)
  for (let i = 0; i < required.length; ++i) {
    if (actual[i] !== required[i]) return actual[i]! > required[i]!
  }
  return true
}

// The Windows driver can encode a different BDF from PnP. Compare the five PCI fields on the
// open XRT handle with the unique present target. A missing field cannot qualify another device.
function matchesWindowsPci(hardware: string | null, pci: Record<string, unknown> | null) {
  const fields =
    /^PCI\\VEN_([0-9A-F]{4})&DEV_([0-9A-F]{4})&SUBSYS_([0-9A-F]{4})([0-9A-F]{4})&REV_([0-9A-F]{2})$/.exec(
      hardware ?? ''
    )
  if (!fields || !pci) return false
  return ['vendor', 'device', 'sub_device', 'sub_vendor', 'revision'].every((key, i) => {
    const value = pci[key]
    return (
      typeof value === 'string' &&
      /^(0x)?[a-f0-9]{1,4}$/i.test(value) &&
      Number.parseInt(value, 16) === Number.parseInt(fields[i + 1]!, 16)
    )
  })
}

async function nativeProbe(
  deps: ProbeDeps,
  build: NonNullable<Options['build']>,
  row: FastFlowLmNpu,
  report: Report
) {
  const win = deps.platform === 'win32'
  const systemRoot = deps.env.SystemRoot ?? 'C:\\Windows'
  // The upstream Linux launcher repairs its library mirror. Use the already packaged mirror read-only.
  const binary = win ? win32.join(build.dir, 'flm.exe') : posix.join(build.dir, 'flm-real')
  const lib = posix.join(build.dir, 'lib')
  const env = win
    ? { SystemRoot: systemRoot, PATH: win32.join(systemRoot, 'System32') }
    : {
        PATH: '/usr/bin:/bin',
        XILINX_XRT: build.dir,
        LD_LIBRARY_PATH: posix.join(lib, 'x86_64-linux-gnu') + ':' + lib,
      }
  const run = (command: string, ...extra: string[]) =>
    deps.run(binary, [command, '--json', ...extra], 15_000, { env, cwd: build.dir })
  if (parseOutput(await run('atomic-capabilities')).environment_probe_protocol !== 1) {
    report.blockers.push('engine-probe-unavailable')
    return
  }
  const index = row.node?.match(/^\/dev\/accel\/accel(\d+)$/)?.[1]
  if (!win && index === undefined) return // Node discovery already recorded its blocker.
  const validation = await run('atomic-validate', ...(index === undefined ? [] : [index]))
  // A negative validation exits 1 and still carries the measured firmware.
  if (validation.code !== 0 && validation.code !== 1) throw Error('validation failed')
  const v = JSON.parse(validation.stdout)
  if (
    v.object !== 'npu_stack_validation' ||
    v.platform !== (win ? 'windows' : 'linux') ||
    v.checks_skipped === true
  )
    throw Error('invalid validation')
  if (!win) {
    const d = Array.isArray(v.devices)
      ? v.devices.find((d: { device?: string }) => d?.device === row.node)
      : null
    if (d?.busy === true) {
      report.blockers.push('device-busy')
      return
    }
    if (
      d &&
      [d.fw_major, d.fw_minor, d.fw_patch, d.fw_build].every((n) => Number.isSafeInteger(n) && n >= 0)
    ) {
      row.firmware = [d.fw_major, d.fw_minor, d.fw_patch, d.fw_build].join('.')
    }
    if (typeof v.drm_version === 'string' && /^\d+\.\d+$/.test(v.drm_version))
      row.driver_version = v.drm_version
    if (!row.driver_version || v.kernel_ok !== true) report.blockers.push('driver-version-unconfirmed')
    if (!row.firmware || d.fw_ok !== true || v.all_fw_ok !== true)
      report.blockers.push('firmware-unconfirmed')
    if (!Number.isInteger(d?.cols) || d.cols < 8 || v.enough_cols !== true)
      report.blockers.push('npu-geometry-unconfirmed')
    if (v.memlock_ok !== true) report.blockers.push('native-memlock-unconfirmed')
  } else if (v.npu_driver_ok !== true) report.blockers.push('driver-version-unconfirmed')
  if (validation.code !== 0 || v.ready !== true || v.amd_device_found !== true || v.npu_platform !== 'aie2p')
    report.blockers.push('native-validation-failed')
  try {
    const result = await run('atomic-xrt')
    const xrt = JSON.parse(result.stdout)
    if (result.code !== 0 && (result.code !== 1 || xrt.open !== false)) throw Error('XRT probe failed')
    row.xrt_visible =
      xrt.open === true &&
      (win
        ? matchesWindowsPci(row.pnp_hardware_id, xrt.pci)
        : row.bdf !== null && typeof xrt.bdf === 'string' && xrt.bdf.toLowerCase() === row.bdf)
  } catch {
    row.xrt_visible = null
  }
  if (win) row.accessible = row.xrt_visible
  if (row.xrt_visible !== true) report.blockers.push('xrt-device-unavailable')
}

/** Fresh facts for the actual owner process and its selected engine. No elevation, model or network. */
export async function probeFastFlowLm(deps: ProbeDeps, options: Options): Promise<Report> {
  const win = deps.platform === 'win32'
  const report: Report = {
    ready: false,
    reason: null,
    devices: [],
    blockers: [],
    runtime_account: null,
    runtime_mode: null,
    runtime_service: null,
    memlock_bytes: null,
    engine_version: options.build?.tag ?? null,
    required: {
      driver: win ? windowsDriver : 'amdxdna DRM >= 0.6',
      firmware: win ? null : '>= 1.1',
      memlock_bytes: win ? null : requiredMemlock,
      xrt: 'selected engine opens the same PCI device',
    },
    automatic_repair_available: false,
  }
  const blockers = report.blockers
  if (!options.supported || deps.arch !== 'x64' || (!win && deps.platform !== 'linux'))
    blockers.push('platform-unsupported')
  else {
    try {
      if (win) await windowsFacts(deps, report, options.desktop === true)
      else {
        const account = (
          options.account ?? (() => ({ name: userInfo().username, uid: process.geteuid?.() }))
        )()
        if (account.name) report.runtime_account = account.name
        if (account.uid === 0) blockers.push('privileged-account')
        if (account.uid === undefined) blockers.push('account-unknown')
        const [limits, cgroup, devices, status] = await Promise.all([
          deps.fs.readFile('/proc/self/limits').catch(() => ''),
          deps.fs.readFile('/proc/self/cgroup').catch(() => ''),
          linuxDevices(deps, options),
          deps.fs.readFile('/proc/self/status').catch(() => ''),
        ])
        // DAC override/read-search, IPC_LOCK and SYS_ADMIN can bypass the checks for this account.
        const caps = /^CapEff:\s*([0-9a-f]+)$/im.exec(status)?.[1]
        if (!caps) blockers.push('account-unknown')
        else if ((BigInt('0x' + caps) & 0x204006n) !== 0n && !blockers.includes('privileged-account'))
          blockers.push('privileged-account')
        report.devices = devices
        linuxMode(cgroup, report, options.desktop === true)
        report.memlock_bytes =
          /^Max locked memory\s+(unlimited|\d+)\s+(?:unlimited|\d+)\s+bytes\s*$/m.exec(limits)?.[1] ?? null
      }
      if (!report.runtime_account || !report.runtime_mode) blockers.push('runtime-identity-unknown')
      const targets = report.devices.filter((row) => row.generation === 'xdna2')
      const target = targets[0]
      if (!target)
        blockers.push(
          report.devices.some((row) => row.generation === null) ? 'npu-generation-unknown' : 'xdna2-not-found'
        )
      else if (targets.length !== 1) blockers.push('ambiguous-npu')
      else {
        if (target.driver !== 'bound') blockers.push('driver-' + target.driver)
        else if (win && (!target.driver_version || !windowsVersionOK(target.driver_version)))
          blockers.push('driver-version-unconfirmed')
        else if (!win && !target.accessible)
          blockers.push(target.accessible === false ? 'device-access-denied' : 'device-access-unknown')
        if (!win) {
          if (!report.memlock_bytes) blockers.push('memlock-unknown')
          else if (
            report.memlock_bytes !== 'unlimited' &&
            BigInt(report.memlock_bytes) < BigInt(requiredMemlock)
          )
            blockers.push('memlock-too-low')
        }
        if (!options.build) blockers.push('engine-not-installed')
        // Limits may be low even when the stack opens successfully. Keep both measurements.
        if (
          options.build &&
          target.driver === 'bound' &&
          (win || target.accessible === true) &&
          report.runtime_account &&
          report.runtime_mode &&
          !blockers.includes('privileged-account') &&
          !blockers.includes('account-unknown')
        ) {
          await nativeProbe(deps, options.build, target, report)
        }
        target.ready = blockers.length === 0
      }
    } catch {
      blockers.push('probe-inconclusive')
    }
  }
  report.ready = blockers.length === 0
  report.reason = blockers[0] ?? null
  return report
}
