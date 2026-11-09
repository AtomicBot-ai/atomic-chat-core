import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { makeTmpDataFolder, type TmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import { verifyRocmWheel } from './windows-rocm-wheel.js'

let data: TmpDataFolder
const name = 'rocm_sdk_libraries'
const version = '10.0.0'
const recordPath = `${name}-${version}.dist-info/RECORD`
const payloadPath = '_rocm_sdk_libraries/bin/hipblas.dll'
const payload = 'runtime'
const digest = createHash('sha256').update(payload).digest('base64url')
const entry = `${payloadPath},sha256=${digest},${payload.length}`
const record = `${entry}\n${recordPath},,\n`
const verify = () => verifyRocmWheel(data.root, name, version)
const saveRecord = (text: string) => writeFile(join(data.root, recordPath), text)
beforeEach(async () => {
  data = await makeTmpDataFolder('rocm-wheel-')
  await mkdir(join(data.root, '_rocm_sdk_libraries/bin'), { recursive: true })
  await mkdir(join(data.root, `${name}-${version}.dist-info`))
  await writeFile(join(data.root, payloadPath), payload)
  await saveRecord(record)
})
afterEach(() => data.cleanup())

it('accepts a complete wheel whose payload matches RECORD', async () => {
  await expect(verify()).resolves.toBeUndefined()
})
it('rejects same-size tampering and unrecorded extra payloads', async () => {
  await writeFile(join(data.root, payloadPath), 'changed')
  await expect(verify()).rejects.toThrow(/integrity/)
  await writeFile(join(data.root, payloadPath), payload)
  await writeFile(join(data.root, '_rocm_sdk_libraries/bin/extra.dll'), 'extra')
  await expect(verify()).rejects.toThrow(/integrity/)
})
it.each([
  `${entry}\n${entry}\n${recordPath},,\n`,
  `../outside,sha256=${digest},7\n${recordPath},,\n`,
  record.replace('sha256=', 'sha512='),
  record.replace(',7\n', ',8\n'),
])('rejects ambiguous, unsafe or inconsistent RECORD entries (%s)', async (invalid) => {
  await saveRecord(invalid)
  await expect(verify()).rejects.toThrow(/integrity/)
})
