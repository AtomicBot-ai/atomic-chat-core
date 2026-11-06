import { spawn } from 'node:child_process'
import { HeadAndTail } from '../../runtime/shared/index.js'

export const npuCommandEnv = {
  PATH: '/usr/sbin:/usr/bin:/sbin:/bin',
  LC_ALL: 'C',
  HOME: '/root',
  DEBIAN_FRONTEND: 'noninteractive',
}

/** After unpack starts, drain output until dpkg closes; a slow DKMS build must be allowed to finish. */
export function installNpuArchives(files: string[], start = spawn): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = start('/usr/bin/dpkg', ['--refuse-downgrade', '--install', ...files], {
      cwd: '/',
      env: npuCommandEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    })
    const log = new HeadAndTail(32 * 1024)
    child.stdout!.on('data', (chunk: Buffer) => log.push(chunk))
    child.stderr!.on('data', (chunk: Buffer) => log.push(chunk))
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) resolve()
      else reject(Error(`dpkg stopped (${code ?? signal}): ${log.text()}`))
    })
  })
}
