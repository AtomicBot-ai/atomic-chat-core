import { spawn } from 'node:child_process'
import { expect, it } from 'vitest'
import { installNpuArchives } from './linux-npu-dpkg.js'
it.each([0, 1])('drains a verbose DKMS transaction and preserves its final exit %s', async (code) => {
  const start = ((exe: string, args: string[], opts: Parameters<typeof spawn>[2]) => {
    expect(exe).toBe('/usr/bin/dpkg')
    expect(args).toEqual(['--refuse-downgrade', '--install', '/stage/driver.deb'])
    return spawn(
      process.execPath,
      [
        '-e',
        `process.stdout.write('x'.repeat(17*1024*1024)+'\\n',()=>{process.stderr.write('driver finished\\n');process.exitCode=${code}})`,
      ],
      { ...opts, cwd: process.cwd() }
    )
  }) as typeof spawn
  const result = installNpuArchives(['/stage/driver.deb'], start)
  if (code) await expect(result).rejects.toThrow('driver finished')
  else await expect(result).resolves.toBeUndefined()
})
