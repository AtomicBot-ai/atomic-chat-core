import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import fixture from '../../test/fixtures/strata/catalog.json' with { type: 'json' }
import { buildGguf } from '../../test/helpers/gguf-builder.js'
import { makeTmpDataFolder, type TmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import { parseStrataDescriptor, strataSourceDigest } from '../client/index.js'
import { StrataRegistry } from './strata.js'
import { serializeModelYml } from './model-yml.js'
const dirs: TmpDataFolder[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await d.cleanup()
})
async function model(architecture = 'qwen4exp', metadataOnlyFirstShard = false) {
  const data = await makeTmpDataFolder('atomic-strata-model-')
  dirs.push(data)
  const descriptor = parseStrataDescriptor(Object.values(fixture.models)[0]!.definition)
  const dir = join(data.layout.provider('strata').modelsDir, 'tiny')
  for (const file of descriptor.files) {
    const index = descriptor.inputs.weights.indexOf(file.path)
    const body =
      index >= 0
        ? buildGguf({
            metadata: {
              ...(index === 0 ? { 'general.architecture': architecture } : {}),
              'split.no': index,
              'split.count': descriptor.inputs.weights.length,
              'split.tensors.count': descriptor.inputs.weights.length - Number(metadataOnlyFirstShard),
            },
            tensors:
              metadataOnlyFirstShard && index === 0
                ? []
                : [{ name: 'tensor' + index, type: 0, dims: [1], bitsPerWeight: 32 }],
          })
        : Buffer.from('fixture')
    file.size = body.length
    file.sha256 = createHash('sha256').update(body).digest('hex')
    await mkdir(dirname(join(dir, file.path)), { recursive: true })
    await writeFile(join(dir, file.path), body)
  }
  descriptor.requirements.download_bytes = descriptor.files.reduce((sum, f) => sum + f.size, 0)
  const block = { schema_version: 1, source_digest: await strataSourceDigest(descriptor), descriptor }
  await writeFile(
    join(dir, 'model.yml'),
    serializeModelYml({ model_path: 'strata/models/tiny/' + descriptor.inputs.weights[0], strata: block })
  )
  return { data, descriptor, dir, registry: new StrataRegistry(data.layout), block }
}
it('discovers acquisition metadata and verifies all inputs without writing a readiness claim', async () => {
  const t = await model()
  const before = await readFile(join(t.dir, 'model.yml'), 'utf8')
  expect(await t.registry.list()).toMatchObject([{ id: 'tiny', strata: t.block }])
  expect(await t.registry.verify('tiny')).toMatchObject({ id: 'tiny', strata: t.block })
  expect(await readFile(join(t.dir, 'model.yml'), 'utf8')).toBe(before)
})
it.each(['hash', 'missing', 'wrong-architecture', 'digest'])(
  'rejects %s in an installed source set',
  async (mode) => {
    const t = await model(mode === 'wrong-architecture' ? 'llama' : 'qwen4exp')
    const file = join(t.dir, t.descriptor.files[0]!.path)
    if (mode === 'hash') {
      const bytes = await readFile(file)
      bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1
      await writeFile(file, bytes)
    }
    if (mode === 'missing') await rm(file)
    if (mode === 'digest')
      await writeFile(
        join(t.dir, 'model.yml'),
        serializeModelYml({ model_path: 'ignored', strata: { ...t.block, source_digest: '0'.repeat(64) } })
      )
    await expect(t.registry.verify('tiny')).rejects.toMatchObject({ code: 'MODEL_INCOMPATIBLE' })
  }
)
it.skipIf(process.platform === 'win32')(
  'refuses redirected inputs and model ids outside the registry',
  async () => {
    const t = await model()
    const file = join(t.dir, t.descriptor.files[0]!.path)
    await writeFile(join(t.data.root, 'outside'), await readFile(file))
    await rm(file)
    await symlink(join(t.data.root, 'outside'), file)
    await expect(t.registry.verify('tiny')).rejects.toThrow()
    await expect(t.registry.get('../outside')).rejects.toThrow()
  }
)

it('accepts a split with a metadata-only first shard and verifies the remaining tensors', async () => {
  const t = await model('qwen4exp', true)
  expect(await t.registry.verify('tiny')).toMatchObject({ id: 'tiny', strata: t.block })
})
