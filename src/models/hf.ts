/**
 * Hugging Face GGUF discovery and import used by `serve owner/repo`. The HTTP metadata call is
 * separate from the downloader so selection is pure and tests never need the public service.
 */

import { stat } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { AtomicCoreError } from '../contracts/index.js'
import type { CoreEvents } from '../contracts/index.js'
import type { DataLayout } from '../config/index.js'
import { modelDirFromId } from '../config/index.js'
import { Downloader } from '../downloads/index.js'
import type { ModelRegistry } from './registry.js'

export interface HfFileInfo {
  filename: string
  size: number
  sha256?: string
  downloadUrl: string
}

export interface HfDownloadOptions {
  layout: DataLayout
  registry: ModelRegistry
  repoId: string
  file: HfFileInfo
  fetch?: typeof fetch
  env?: NodeJS.ProcessEnv
  emit?: <K extends 'download:progress' | 'model:validation-started'>(name: K, payload: CoreEvents[K]) => void
}

/** Exactly `owner/repo`, with the same conservative character set as the legacy Rust CLI. */
export function looksLikeHfRepo(value: string): boolean {
  if (value.startsWith('/') || value.startsWith('.') || value.startsWith('~')) return false
  const parts = value.split('/')
  return (
    parts.length === 2 &&
    parts.every(
      (part) => part.length > 0 && part !== '.' && part !== '..' && /^[\p{L}\p{N}._-]+$/u.test(part)
    )
  )
}

/** `HF_TOKEN` is the Hub-wide convention; retain the older alias as a fallback. */
export function hfToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return nonEmpty(env['HF_TOKEN']) ?? nonEmpty(env['HUGGING_FACE_HUB_TOKEN'])
}

/** Fetch and normalize the GGUF siblings, smallest first. */
export async function fetchHfGgufFiles(
  repoId: string,
  options: { fetch?: typeof fetch; token?: string } = {}
): Promise<HfFileInfo[]> {
  if (!looksLikeHfRepo(repoId)) {
    throw new AtomicCoreError('INVALID_ARGUMENT', `Invalid Hugging Face repository id "${repoId}".`)
  }
  const fetchImpl = options.fetch ?? fetch
  const headers = options.token ? { authorization: `Bearer ${options.token}` } : undefined
  const url = `https://huggingface.co/api/models/${repoId}?blobs=true&files_metadata=true`
  const response = await fetchImpl(url, { ...(headers ? { headers } : {}) })
  if (!response.ok) {
    const details =
      response.status === 401 || response.status === 403
        ? 'The repository may be gated; set HF_TOKEN and accept its access conditions.'
        : response.status === 404
          ? 'Check the owner/repository spelling.'
          : undefined
    throw new AtomicCoreError(
      'IO_ERROR',
      `Hugging Face returned HTTP ${response.status} for "${repoId}".`,
      details
    )
  }
  const body = (await response.json()) as { siblings?: unknown }
  if (!Array.isArray(body.siblings)) {
    throw new AtomicCoreError('IO_ERROR', 'Unexpected Hugging Face model metadata response.')
  }
  const files = body.siblings
    .map(parseSibling(repoId))
    .filter((file): file is HfFileInfo => file !== undefined)
    .sort((a, b) => a.size - b.size || a.filename.localeCompare(b.filename))
  if (files.length === 0) {
    throw new AtomicCoreError('MODEL_NOT_FOUND', `No GGUF files found in Hugging Face repo "${repoId}".`)
  }
  return files
}

/** Prefer the Rust CLI's default quantization, then the largest known file. */
export function chooseDefaultHfFile(files: HfFileInfo[]): HfFileInfo {
  const preferred = files.find((file) => file.filename.includes('Q4_K_XL'))
  const chosen =
    preferred ??
    files.reduce<HfFileInfo | undefined>((best, file) => {
      return !best || file.size > best.size ? file : best
    }, undefined)
  if (!chosen) throw new AtomicCoreError('MODEL_NOT_FOUND', 'No GGUF file is available to download.')
  return chosen
}

/** Download into the app's shared model tree, validate, then atomically publish via `model.yml`. */
export async function downloadHfModel(options: HfDownloadOptions): Promise<string> {
  const { layout, registry, repoId, file } = options
  if (!looksLikeHfRepo(repoId)) {
    throw new AtomicCoreError('INVALID_ARGUMENT', `Invalid Hugging Face repository id "${repoId}".`)
  }
  assertSafeRepoFile(file.filename)
  const destination = join(modelDirFromId(registry.modelsDir, repoId), ...file.filename.split('/'))
  const savePath = relative(layout.root, destination).split(sep).join('/')
  const token = hfToken(options.env)
  const downloader = new Downloader({
    dataFolder: layout.root,
    platform: process.platform,
    fetch: options.fetch ?? fetch,
    emit: options.emit ?? (() => {}),
  })
  await downloader.download(
    `hf:${repoId}`,
    [
      {
        url: file.downloadUrl,
        save_path: savePath,
        size: file.size || null,
        sha256: file.sha256 ?? null,
        model_id: repoId,
      },
    ],
    { headers: token ? { authorization: `Bearer ${token}` } : {}, resume: true }
  )
  const actualSize = (await stat(destination)).size
  await registry.write(repoId, {
    model_path: savePath,
    name: repoId.split('/')[1] as string,
    size_bytes: actualSize,
    model_size_bytes: actualSize,
    ...(file.sha256 ? { model_sha256: file.sha256 } : {}),
    embedding: false,
  })
  return repoId
}

function parseSibling(repoId: string): (value: unknown) => HfFileInfo | undefined {
  return (value) => {
    if (!value || typeof value !== 'object') return undefined
    const sibling = value as Record<string, unknown>
    const filename = sibling['rfilename']
    if (typeof filename !== 'string' || !filename.toLowerCase().endsWith('.gguf')) return undefined
    try {
      assertSafeRepoFile(filename)
    } catch {
      return undefined
    }
    const lfs =
      sibling['lfs'] && typeof sibling['lfs'] === 'object' ? (sibling['lfs'] as Record<string, unknown>) : {}
    const size = finiteSize(lfs['size']) ?? finiteSize(sibling['size']) ?? 0
    const sha256 = typeof lfs['sha256'] === 'string' && lfs['sha256'] ? lfs['sha256'] : undefined
    const encoded = filename.split('/').map(encodeURIComponent).join('/')
    return {
      filename,
      size,
      ...(sha256 ? { sha256 } : {}),
      downloadUrl: `https://huggingface.co/${repoId}/resolve/main/${encoded}`,
    }
  }
}

function assertSafeRepoFile(filename: string): void {
  const parts = filename.split('/')
  if (
    filename.includes('\\') ||
    isAbsolute(filename) ||
    parts.some((part) => !part || part === '.' || part === '..')
  ) {
    throw new AtomicCoreError('INVALID_ARGUMENT', `Unsafe Hugging Face filename "${filename}".`)
  }
}

function finiteSize(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}
