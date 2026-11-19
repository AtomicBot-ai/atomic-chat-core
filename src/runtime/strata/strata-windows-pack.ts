import { cp, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AtomicCoreError } from '../../contracts/index.js'

const namespace = '\\\\?\\'

/** Legacy DeepSeek appends a forward slash, which Windows refuses inside a verbatim path. */
export async function stageStrataWindowsPack(prepared: string, runtime: string): Promise<boolean> {
  const original = join(prepared, 'pack')
  const sourceMetadata = join(original, 'ds4.txt')
  const metadata = await readFile(sourceMetadata, 'utf8')
  const match = /^model_dir ([^\r\n]+)$/m.exec(metadata)
  const path = match?.[1]
  if (!path?.startsWith(namespace)) return false

  const target = path.slice(namespace.length)
  const ordinary = /^[a-z]:\\/i.test(target)
    ? target
    : /^UNC\\[^\\]+\\[^\\]+/i.test(target)
      ? '\\\\' + target.slice(4)
      : undefined
  if (!ordinary)
    throw new AtomicCoreError('MODEL_INCOMPATIBLE', 'Strata cannot resolve the Windows model directory.')

  const pack = join(runtime, 'pack')
  await mkdir(runtime, { mode: 0o700 })
  try {
    await cp(original, pack, {
      recursive: true,
      errorOnExist: true,
      force: false,
      filter: (entry) => entry !== sourceMetadata,
    })
    if (!(await lstat(pack)).isDirectory())
      throw new AtomicCoreError('IO_ERROR', 'Strata launch pack is not a directory.')
    await writeFile(
      join(pack, 'ds4.txt'),
      metadata.replace(/^model_dir [^\r\n]+$/m, () => 'model_dir ' + ordinary),
      { flag: 'wx', mode: 0o600 }
    )
  } catch (error) {
    await rm(runtime, { recursive: true, force: true }).catch(() => {})
    throw error
  }
  return true
}
