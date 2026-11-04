/**
 * `geniex-host inspect <path>` (openspec change `add-geniex-runtime`, task 5.2): what a model says
 * about itself, read without the library — GenieX has no metadata call short of creating the model.
 * A GGUF file is read by its header (`general.architecture`, `<arch>.context_length`,
 * `general.file_type`, `tokenizer.chat_template`), and an `mmproj*.gguf` beside it means vision; an
 * AI Hub bundle folder is read by the files AI Hub v0.65.0 puts in it (spike S4, 2026-10-28):
 * `genie_config.json` (the dialog config with the context size; what makes a folder a bundle),
 * `metadata.json` (`runtime`, `precision`, tool versions) and `htp_backend_ext_config.json` (the
 * Hexagon generation, which names the chip). The reader leaves `null` for what it cannot find.
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { GENIEX_CHIPS } from '../../../contracts/index.js'
import type {
  GeniexBundleMetadata,
  GeniexChip,
  GeniexGgufMetadata,
  GeniexModelMetadata,
} from '../../../contracts/index.js'
import { GgufParseError, readGgufMetadataFromFile } from '../../../models/index.js'

/** `llama_ftype` of llama.cpp, by `general.file_type`. */
const FILE_TYPES: Record<number, string> = {
  0: 'F32',
  1: 'F16',
  2: 'Q4_0',
  3: 'Q4_1',
  7: 'Q8_0',
  8: 'Q5_0',
  9: 'Q5_1',
  10: 'Q2_K',
  11: 'Q3_K_S',
  12: 'Q3_K_M',
  13: 'Q3_K_L',
  14: 'Q4_K_S',
  15: 'Q4_K_M',
  16: 'Q5_K_S',
  17: 'Q5_K_M',
  18: 'Q6_K',
  19: 'IQ2_XXS',
  20: 'IQ2_XS',
  21: 'Q2_K_S',
  22: 'IQ3_XS',
  23: 'IQ3_XXS',
  24: 'IQ1_S',
  25: 'IQ4_NL',
  26: 'IQ3_S',
  27: 'IQ3_M',
  28: 'IQ2_S',
  29: 'IQ2_M',
  30: 'IQ4_XS',
  31: 'IQ1_M',
  32: 'BF16',
  36: 'TQ1_0',
  37: 'TQ2_0',
  38: 'MXFP4_MOE',
}

/** The bundle's dialog config (design "Бандлы AI Hub", as S4 found it): without it, no bundle. */
export const BUNDLE_MANIFEST = 'genie_config.json'
const BUNDLE_METADATA = 'metadata.json'
const BUNDLE_HTP_CONFIG = 'htp_backend_ext_config.json'
/** The `runtime` of `metadata.json` of a bundle the `qairt` plugin runs; `genie` bundles are not. */
const BUNDLE_RUNTIME = 'geniex_qairt'
/**
 * Hexagon generation (`devices[].dsp_arch` of `htp_backend_ext_config.json`) → the Snapdragon X it
 * ships in. S4: the x2-elite bundle says `v81`; `v73` is X Elite's Hexagon.
 */
const DSP_ARCH_CHIP: Record<string, GeniexChip> = { v73: 'x-elite', v81: 'x2-elite' }
/** `mmproj-F16.gguf` (llama.cpp's spelling) and `gemma-4-E2B-it-mmproj.gguf` (Google's). */
const MMPROJ_RE = /mmproj.*\.gguf$/i

/** The model cannot be read: not a GGUF file, not a bundle folder, or a broken one. */
export class GeniexInspectError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GeniexInspectError'
  }
}

const whole = (value: unknown): number | null => {
  const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

/** A GGUF file's facts from its header, and whether an `mmproj*.gguf` lies beside it. */
export async function inspectGgufFile(file: string): Promise<GeniexGgufMetadata> {
  let metadata: Record<string, string>
  try {
    metadata = (await readGgufMetadataFromFile(file)).metadata
  } catch (error) {
    if (error instanceof GgufParseError)
      throw new GeniexInspectError(`${file} is not a GGUF file: ${error.message}`)
    throw new GeniexInspectError(
      `${file} cannot be read: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  const architecture = metadata['general.architecture'] ?? null
  const fileType = whole(metadata['general.file_type'])
  const siblings = await readdir(dirname(file)).catch(() => [] as string[])
  return {
    kind: 'gguf',
    architecture,
    max_context_tokens: architecture ? whole(metadata[`${architecture}.context_length`]) : null,
    quantization:
      fileType !== null
        ? (FILE_TYPES[fileType] ?? null)
        : metadata['general.file_type'] === '0'
          ? 'F32'
          : null,
    chat_template: typeof metadata['tokenizer.chat_template'] === 'string',
    vision: siblings.some((name) => MMPROJ_RE.test(name) && name !== basename(file)),
  }
}

const pick = (record: Record<string, unknown>, keys: string[]): unknown => {
  for (const key of keys) {
    const value = key
      .split('.')
      .reduce<unknown>(
        (at, part) => (at && typeof at === 'object' ? (at as Record<string, unknown>)[part] : undefined),
        record
      )
    if (value !== undefined && value !== null) return value
  }
  return undefined
}

/** `x-elite` from the spellings AI Hub uses (`qualcomm-snapdragon-x-elite`, `Snapdragon X Elite`, `x-elite`). */
export function bundleChip(value: unknown): GeniexChip | null {
  if (typeof value !== 'string') return null
  const flat = value.toLowerCase().replace(/[^a-z0-9]+/g, '-')
  for (const chip of GENIEX_CHIPS) if (flat.endsWith(chip) || flat.includes(`-${chip}-`)) return chip
  if (/x2-elite|x2e/.test(flat)) return 'x2-elite'
  if (/x-elite|x1e/.test(flat)) return 'x-elite'
  return null
}

/** A JSON object from a bundle file; `null` when the file is absent. */
async function bundleJson(dir: string, name: string): Promise<Record<string, unknown> | null> {
  const file = join(dir, name)
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new GeniexInspectError(
      `${file} cannot be read: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw new GeniexInspectError(`${file} is not a JSON object`)
  return raw as Record<string, unknown>
}

/** An AI Hub bundle folder's facts from `genie_config.json`, `metadata.json` and the HTP config. */
export async function inspectBundle(dir: string): Promise<GeniexBundleMetadata> {
  const genie = await bundleJson(dir, BUNDLE_MANIFEST)
  if (!genie) throw new GeniexInspectError(`${dir} is not an AI Hub bundle: no ${BUNDLE_MANIFEST} in it`)
  const metadata = (await bundleJson(dir, BUNDLE_METADATA)) ?? {}
  const runtime = pick(metadata, ['runtime'])
  if (typeof runtime === 'string' && runtime !== BUNDLE_RUNTIME)
    throw new GeniexInspectError(`${dir} is a ${runtime} bundle, not ${BUNDLE_RUNTIME}`)
  const htp = (await bundleJson(dir, BUNDLE_HTP_CONFIG)) ?? {}
  const devices = pick(htp, ['devices'])
  const dspArch = Array.isArray(devices)
    ? pick((devices[0] ?? {}) as Record<string, unknown>, ['dsp_arch'])
    : undefined
  const version = pick(metadata, ['min_runtime_version', 'min_geniex_version', 'tool_versions.geniex'])
  const precision = pick(metadata, ['precision'])
  return {
    kind: 'qairt',
    chip:
      (typeof dspArch === 'string' ? DSP_ARCH_CHIP[dspArch.toLowerCase()] : undefined) ??
      bundleChip(pick(metadata, ['chipset', 'chip'])) ??
      bundleChip(basename(dir)),
    max_context_tokens: whole(pick(genie, ['dialog.context.size', 'context_length'])),
    precision: typeof precision === 'string' && precision !== '' ? precision : null,
    min_runtime_version:
      typeof version === 'string' && /^\d+\.\d+(\.\d+)?/.test(version)
        ? (/^\d+\.\d+(\.\d+)?/.exec(version) as RegExpExecArray)[0]
        : null,
  }
}

/** A file is a GGUF; a folder is a bundle. */
export async function inspectGeniexModel(path: string): Promise<GeniexModelMetadata> {
  const info = await stat(path).catch(() => null)
  if (!info) throw new GeniexInspectError(`${path} does not exist`)
  return info.isDirectory() ? inspectBundle(path) : inspectGgufFile(path)
}
