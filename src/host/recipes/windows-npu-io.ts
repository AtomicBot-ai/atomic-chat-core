import { execFile } from 'node:child_process'
import { systemEnvironment, windowsSystemDirectory } from './windows-system.js'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { win32 } from 'node:path'
import { promisify } from 'node:util'
import { WINDOWS_NPU_DRIVER as driver } from '../../runtime/fastflowlm/environment/index.js'
import { checkNpuCab, type NpuInstallerIo } from './windows-amd-npu.js'
import { NPU_SETUP_API } from './windows-npu-setupapi.js'

const infSha256 = '1d6a1615c13a85c74b9fbd66353857f4ab333b3369123d5ddb00dd2336911a0f'
const readState = String.raw`
function Get-TargetState {
  $os = Get-CimInstance Win32_OperatingSystem
  if ($os.ProductType -ne 1 -or [int]$os.BuildNumber -lt 22000 -or
      [Environment]::Is64BitProcess -ne $true -or [int](Get-CimInstance Win32_Processor | Select-Object -First 1).Architecture -ne 9) {return 'unsupported'}
  $device = @(Get-PnpDevice -PresentOnly -InstanceId $env:ATOMIC_NPU_ID)
  if ($device.Count -ne 1 -or $device[0].InstanceId -ne $env:ATOMIC_NPU_ID) {return 'unsupported'}
  $problem = (Get-PnpDeviceProperty -InstanceId $env:ATOMIC_NPU_ID -KeyName DEVPKEY_Device_ProblemCode).Data
  if ($null -eq $problem) {return 'unsupported'}
  $version = (Get-PnpDeviceProperty -InstanceId $env:ATOMIC_NPU_ID -KeyName DEVPKEY_Device_DriverVersion -ErrorAction SilentlyContinue).Data
  if ($problem -eq 28 -and !$version) {return 'needed'}
  if (!$version) {return 'unsupported'}
  if ($problem -eq 0 -and [version]$version -ge [version]'32.0.203.304') {return 'satisfied'}
  if ($problem -in @(0,28) -and [version]$version -lt [version]'32.0.203.304') {return 'needed'}
  return 'unsupported'
}`
const createStage = String.raw`
$acl = New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetSecurityDescriptorSddlForm('O:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;RC;;;OW)')
[void][IO.Directory]::CreateDirectory($env:ATOMIC_NPU_STAGE, $acl)
`
const verifyCab = String.raw`
function Assert-Hash($path,$hash) {
  if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $hash) { throw "Package hash mismatch: $path" }
}
$inf = Join-Path $env:ATOMIC_NPU_STAGE 'package\kipudrv.inf'
$cat = Join-Path $env:ATOMIC_NPU_STAGE 'package\kipudrv.cat'
Assert-Hash $inf '${infSha256}'
Assert-Hash $cat '${driver.catalog_sha256}'
$sig = Get-AuthenticodeSignature -LiteralPath $cat
if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.GetNameInfo('SimpleName',$false) -cne '${driver.signer}') {throw 'Windows rejected the NPU catalog publisher or signature'}
`
const checkCompatibility = String.raw`
Add-Type -Path (Join-Path $env:ATOMIC_NPU_STAGE 'driver.cs')
if ([AtomicNpuSetup]::SelectDriver($env:ATOMIC_NPU_ID, $inf, $false) -ne 0) {throw 'Incompatible NPU driver'}
`
const install = String.raw`
$inf = Join-Path $env:ATOMIC_NPU_STAGE 'package\kipudrv.inf'
Add-Type -Path (Join-Path $env:ATOMIC_NPU_STAGE 'driver.cs')
$state = Get-TargetState
if ($state -eq 'satisfied') { 'satisfied'; exit 0 }
if ($state -ne 'needed') {throw 'NPU target changed during staging'}
try { [AtomicNpuSetup]::SelectDriver($env:ATOMIC_NPU_ID, $inf, $true) }
catch {
  $cause = $_.Exception.GetBaseException()
  if ($cause -is [ComponentModel.Win32Exception] -and $cause.NativeErrorCode -ne 0) { $cause.NativeErrorCode }
  else {throw}
}
`
async function powershell(system32: string, cwd: string, script: string, id: string) {
  const ps = win32.join(system32, 'WindowsPowerShell', 'v1.0')
  const { stdout } = await promisify(execFile)(
    win32.join(ps, 'powershell.exe'),
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; " + script,
    ],
    {
      cwd: system32,
      windowsHide: true,
      encoding: 'utf8',
      env: {
        ...systemEnvironment(system32, cwd),
        ATOMIC_NPU_STAGE: cwd,
        ATOMIC_NPU_ID: id,
      },
    }
  )
  return stdout.trim()
}
/** Preserve the native outcome if an antivirus scanner still holds an extracted file open. */
export async function runInNpuStage<T>(
  stage: string,
  run: (stage: string) => Promise<T>,
  remove = (path: string) => rm(path, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }),
  warn = (message: string) => process.emitWarning(message)
): Promise<T> {
  try {
    return await run(stage)
  } finally {
    await remove(stage).catch((error: Error) =>
      warn(`Could not clean up protected NPU stage ${stage}: ${error.message}`)
    )
  }
}
export function windowsNpuIo(options: { fetch?: typeof fetch } = {}): NpuInstallerIo {
  return {
    async state(id) {
      const system32 = await windowsSystemDirectory()
      const result = await powershell(system32, system32, readState + '\nGet-TargetState', id)
      return result === 'needed' || result === 'satisfied' ? result : 'unsupported'
    },
    async withStage(run) {
      const system32 = await windowsSystemDirectory()
      // System32 is administrator-writable. Normal users cannot create, replace or redirect these children.
      const stage = win32.join(system32, 'AtomicChat-Npu-' + randomUUID())
      await powershell(system32, stage, createStage, '')
      return runInNpuStage(stage, run)
    },
    async download(stage) {
      const response = await (options.fetch ?? fetch)(driver.url, {
        redirect: 'error',
        signal: AbortSignal.timeout(120000),
      })
      if (!response.ok || !response.body) throw Error('NPU CAB download failed: ' + response.status)
      const bytes = Buffer.alloc(driver.size)
      let offset = 0
      const reader = response.body.getReader()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (value.length > bytes.length - offset) throw Error('NPU CAB exceeds the pinned size.')
          bytes.set(value, offset)
          offset += value.length
        }
      } finally {
        await reader.cancel()
      }
      checkNpuCab(bytes.subarray(0, offset))
      await writeFile(win32.join(stage, 'driver.cab'), bytes, { flag: 'wx' })
    },
    async verify(stage, id) {
      const system32 = await windowsSystemDirectory(),
        cab = win32.join(stage, 'driver.cab'),
        packageDir = win32.join(stage, 'package')
      checkNpuCab(await readFile(cab))
      await mkdir(packageDir)
      await promisify(execFile)(win32.join(system32, 'expand.exe'), [cab, '-F:*', packageDir], {
        cwd: system32,
        windowsHide: true,
        env: { SystemRoot: win32.dirname(system32), PATH: system32, TEMP: stage, TMP: stage },
      })
      await writeFile(win32.join(stage, 'driver.cs'), NPU_SETUP_API, { flag: 'wx' })
      await powershell(await windowsSystemDirectory(), stage, verifyCab + '\n' + checkCompatibility, id)
    },
    async install(stage, id) {
      const result = await powershell(await windowsSystemDirectory(), stage, readState + '\n' + install, id)
      const code = result.split(/\r?\n/).at(-1)?.trim()
      if (code === 'satisfied') return 'satisfied'
      if (!code || !/^-?\d{1,10}$/.test(code) || !Number.isSafeInteger(Number(code)))
        throw Error('Unexpected Windows NPU installer result.')
      return Number(code)
    },
  }
}
