import { realpath } from 'node:fs'
import { win32 } from 'node:path'
import { promisify } from 'node:util'

/** Resolve the kernel's SystemRoot link independently of the caller's environment. */
export const windowsSystemDirectory = (resolve = promisify(realpath.native)) =>
  resolve(String.raw`\\?\GLOBALROOT\SystemRoot\System32`)

export function systemEnvironment(system32: string, temp: string) {
  const root = win32.dirname(system32)
  return {
    SystemRoot: root,
    windir: root,
    PATH: system32,
    SystemDrive: win32.parse(root).root.slice(0, 2),
    ComSpec: win32.join(system32, 'cmd.exe'),
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    PSModulePath: win32.join(system32, 'WindowsPowerShell', 'v1.0', 'Modules'),
    TEMP: temp,
    TMP: temp,
  }
}
