import { fakeProbeDeps } from './fake-probe-deps.js'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import candidate from '../fixtures/fastflowlm/qwen3-candidate.json' with { type: 'json' }
import { buildFastFlowLmConfig, parseFastFlowLmDescriptor } from '../../src/client/index.js'
import type { ModelYmlFastFlowLm } from '../../src/contracts/index.js'

/** The staging Qwen3 layout with tiny synthetic bytes and their own matching hashes. */
export async function writeFlmInstallation(
  root: string,
  config = { flm_version: '0.9.22', max_position_embeddings: 40960 }
) {
  const d = parseFastFlowLmDescriptor(candidate.definition)
  const relative = 'fastflowlm/models/' + d.variant_id
  const dir = join(root, relative)
  for (const f of d.files) {
    const bytes = Buffer.from(f.path === 'config.json' ? JSON.stringify(config) : f.path)
    f.size = bytes.length
    f.sha256 = createHash('sha256').update(bytes).digest('hex')
    await mkdir(dirname(join(dir, f.path)), { recursive: true })
    await writeFile(join(dir, f.path), bytes)
  }
  const metadata: ModelYmlFastFlowLm = {
    ...d,
    schema_version: 1,
    catalog_digest: 'a'.repeat(64),
    model_list_path: 'flm/model_list.json',
    model_info_path: 'flm/model_info.json',
  }
  const { modelList, modelInfo } = buildFastFlowLmConfig(metadata)
  await mkdir(join(dir, 'flm'), { recursive: true })
  await writeFile(join(dir, metadata.model_list_path), JSON.stringify(modelList))
  await writeFile(join(dir, metadata.model_info_path), JSON.stringify(modelInfo))
  const marker = { model_path: relative, fastflowlm: metadata }
  await writeFile(join(dir, 'model.yml'), JSON.stringify(marker))
  return { dir, marker, metadata, modelList, modelInfo }
}

/** PCI enumeration before any driver or engine has been installed, independent of the test machine. */
export function linuxFastFlowLmPci() {
  const root = '/sys/bus/pci/devices'
  const id = '0000:c6:00.1'
  return fakeProbeDeps({
    platform: 'linux',
    dirs: { [root]: [id] },
    files: {
      [root + '/' + id + '/vendor']: '0x1022',
      [root + '/' + id + '/device']: '0x17f0',
      [root + '/' + id + '/revision']: '0x20',
    },
  }).fs
}
