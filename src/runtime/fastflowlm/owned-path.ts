import { isAbsolute, relative, resolve, sep } from 'node:path'
import { canonicalizeExistingPrefix } from '../../downloads/index.js'
import { AtomicCoreError } from '../../contracts/index.js'

/** The data folder may itself be a link. An internal link must never redirect a write into a model. */
export async function ownedFlmPath(root: string, path: string) {
  const inside = relative(root, path)
  if (isAbsolute(inside) || inside === '..' || inside.startsWith('..' + sep))
    throw new AtomicCoreError(
      'FASTFLOWLM_INVALID_INSTALLATION',
      'FastFlowLM path outside the data folder.',
      path
    )
  const expected = resolve(await canonicalizeExistingPrefix(root), inside)
  if (relative(expected, await canonicalizeExistingPrefix(path)) !== '')
    throw new AtomicCoreError('FASTFLOWLM_INVALID_INSTALLATION', 'Redirected FastFlowLM runtime path.', path)
  return expected
}
