/**
 * Hugging Face GGUF discovery: the repository id check, the token, and the GGUF files a repository
 * offers. The core reads this catalog but does not download model files; clients do (ADR
 * 2026-10-15-core-does-not-download-models).
 */

import { isAbsolute } from 'node:path'
import { AtomicCoreError } from '../contracts/index.js'

export interface HfFileInfo {
  filename: string
  size: number
  sha256?: string
  downloadUrl: string
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
