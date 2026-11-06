import { win32 } from 'node:path'
import type { ProbeDeps } from '../../../hardware/index.js'

/** A changed boot proves a previously dispatched installer cannot still be running. */
export async function preparationBoot(deps: ProbeDeps): Promise<string | null> {
  try {
    if (deps.platform === 'linux') {
      const id = (await deps.fs.readFile('/proc/sys/kernel/random/boot_id')).trim()
      return /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(id) ? id : null
    }
    if (deps.platform === 'win32') {
      const ps = win32.join(
        deps.env.SystemRoot ?? 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe'
      )
      const r = await deps.run(
        ps,
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '(Get-CimInstance Win32_OperatingSystem -ErrorAction Stop).LastBootUpTime.ToUniversalTime().Ticks',
        ],
        10000
      )
      if (r?.code === 0 && /^\d{17,19}$/.test(r.stdout.trim())) return r.stdout.trim()
    }
  } catch {
    /* Unknown boot identity cannot retire a pending authorization. */
  }
  return null
}
