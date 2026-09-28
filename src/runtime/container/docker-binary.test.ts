import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DOCKER_BINARY_CANDIDATES, resolveDockerBinary } from './docker-binary.js'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'docker-binary-'))
  dirs.push(dir)
  return dir
}

describe('resolveDockerBinary', () => {
  it('only ever looks in fixed system directories, never PATH', () => {
    expect(DOCKER_BINARY_CANDIDATES).toEqual(['/usr/bin/docker', '/usr/local/bin/docker', '/bin/docker'])
    expect(DOCKER_BINARY_CANDIDATES.every((p) => p.startsWith('/'))).toBe(true)
  })

  it('answers the first candidate that is an executable file', async () => {
    const dir = await tmp()
    const notExecutable = join(dir, 'a')
    const aDirectory = join(dir, 'b')
    const executable = join(dir, 'c')
    const later = join(dir, 'd')
    await writeFile(notExecutable, '')
    await mkdir(aDirectory)
    await writeFile(executable, '#!/bin/sh\n')
    await chmod(executable, 0o755)
    await writeFile(later, '#!/bin/sh\n')
    await chmod(later, 0o755)
    expect(
      await resolveDockerBinary([join(dir, 'missing'), notExecutable, aDirectory, executable, later])
    ).toBe(executable)
  })

  it('answers null when there is none', async () => {
    const dir = await tmp()
    expect(await resolveDockerBinary([join(dir, 'missing')])).toBeNull()
  })
})
