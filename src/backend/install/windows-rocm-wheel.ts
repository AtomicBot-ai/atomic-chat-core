/** Installation-time integrity check for AMD wheels; never used on the model-load fast path. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { AtomicCoreError } from '../../contracts/index.js'

export async function verifyRocmWheel(root: string, name: string, version: string): Promise<void> {
  const recordPath = `${name}-${version}.dist-info/RECORD`
  const text = await readFile(join(root, recordPath), 'utf8')
  const recorded = new Set<string>()
  const fail = () => new AtomicCoreError('ENGINE_BINARY_BROKEN', `ROCm wheel integrity check failed: ${name}`)
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    const [path, digest, size, extra] = line.split(',')
    if (
      !path ||
      extra !== undefined ||
      recorded.has(path) ||
      path.split('/').some((p) => !/^[A-Za-z0-9_.+-]+$/.test(p) || p === '..' || p === '.')
    )
      throw fail()
    recorded.add(path)
    if (path === recordPath && digest === '' && size === '') continue
    if (!digest?.match(/^sha256=[A-Za-z0-9_-]{43}$/) || !size?.match(/^\d+$/)) throw fail()
    const file = join(root, path)
    if ((await stat(file)).size !== Number(size)) throw fail()
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(file)) hash.update(chunk)
    if (`sha256=${hash.digest('base64url')}` !== digest) throw fail()
  }
  async function walk(dir: string, prefix = ''): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = prefix + entry.name
      if (entry.isDirectory()) await walk(join(dir, entry.name), path + '/')
      else if (!entry.isFile() || !recorded.has(path)) throw fail()
    }
  }
  await walk(root)
}
