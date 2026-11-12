/**
 * Disk-failure tagging and preflight checks. Port of `src-tauri/src/core/downloads/disk.rs`.
 *
 * Every filesystem error on the download path is rendered as `Error: [<tag>] <detail>`; the app's
 * telemetry (`classifyDownloadFailure` in `web-app/src/lib/telemetry.ts`) reads the tag out of the
 * string. Tags are the contract (`contracts/errors.ts`), the detail text is not.
 *
 * Node reports OS errors as libuv codes (`ENOSPC`, `EACCES`, …) on every platform — on Windows libuv
 * already maps Win32 codes (ERROR_DISK_FULL → ENOSPC, ERROR_SHARING_VIOLATION → EBUSY, …), so one
 * table covers both sides of the Rust `cfg(unix)` / `cfg(windows)` split.
 */

import type { DiskErrorTag } from '../contracts/index.js'
import { isTransientFsError } from './fs-retry.js'

const CODE_TO_TAG: Record<string, DiskErrorTag> = {
  ENOSPC: 'disk_full',
  EDQUOT: 'disk_full',
  // "File too large": the volume's own size limit for one file (FAT32's 4 GiB), not a full disk.
  EFBIG: 'disk_fs_limit',
  EACCES: 'disk_permission',
  EPERM: 'disk_permission',
  EROFS: 'disk_permission',
  ETXTBSY: 'disk_file_locked',
  EBUSY: 'disk_file_locked',
  ENAMETOOLONG: 'disk_path_too_long',
  ENODEV: 'disk_device_lost',
  ENXIO: 'disk_device_lost',
  ESTALE: 'disk_device_lost',
  EIO: 'disk_device_lost',
  // Rust: ErrorKind::NotFound → DeviceLost (a share or volume that vanished mid-transfer).
  ENOENT: 'disk_device_lost',
}

/** Classify a Node fs error into its subcause tag; unknown → `disk_io`. */
export function classifyIoError(error: unknown): DiskErrorTag {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return (code !== undefined && CODE_TO_TAG[code]) || 'disk_io'
}

/** `Error: [<tag>] <message>` — the shape the frontend parses. */
export function diskErrToString(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return `Error: [${classifyIoError(error)}] ${message}`
}

/** The largest file a FAT/FAT32 volume can hold: 4 GiB minus one byte. */
export const FAT32_MAX_FILE_BYTES = 2 ** 32 - 1

/**
 * The tag of a failed write of `length` bytes at `offset`. FAT32 refuses exactly the write that takes
 * a file past 4 GiB − 1, and Windows words that refusal as a full disk (or an error libuv has no name
 * for): a write that crosses that line and fails as anything but a permission or a lock is the
 * volume's file-size limit. Every other failed write is tagged as `classifyIoError` tags it.
 */
export function writeFaultTag(error: unknown, offset: number, length: number): DiskErrorTag {
  const tag = classifyIoError(error)
  const crosses = offset <= FAT32_MAX_FILE_BYTES && offset + length > FAT32_MAX_FILE_BYTES
  return crosses && (tag === 'disk_full' || tag === 'disk_io' || tag === 'disk_fs_limit')
    ? 'disk_fs_limit'
    : tag
}

/** `diskErrToString` for a failed write, with the FAT32 rule of `writeFaultTag`. */
export function diskWriteErrToString(error: unknown, offset: number, length: number): string {
  const message = error instanceof Error ? error.message : String(error)
  return `Error: [${writeFaultTag(error, offset, length)}] ${message}`
}

/**
 * The tag of a rename or removal that still failed after `retryTransientFs` waited. On Windows a
 * denial on a directory this process has just written is a handle someone else holds (antivirus,
 * the indexer, a server running from the old copy), not a missing permission: the process could
 * write there a moment ago. Elsewhere, and for every other code, `classifyIoError` decides.
 */
export function heldFileFaultTag(error: unknown, platform: NodeJS.Platform | string): DiskErrorTag {
  return platform === 'win32' && isTransientFsError(error) ? 'disk_file_locked' : classifyIoError(error)
}

/** Same shape for a preflight refusal that has no fs error behind it. */
export function diskFaultMessage(tag: DiskErrorTag, detail: string): string {
  return `Error: [${tag}] ${detail}`
}

/** Bytes never consumed on top of the download itself (a volume at zero free bytes kills the app). */
export const FREE_SPACE_HEADROOM = 512 * 1024 * 1024

/** Bytes still to be written given the partial files already on disk (sizes of existing `.tmp`). */
export function remainingBytes(totalSize: number, partialSizes: number[]): number {
  const already = partialSizes.reduce((n, s) => n + s, 0)
  return totalSize > already ? totalSize - already : 0
}

/** Human-readable size for the refusal message. */
export function formatBytes(bytes: number): string {
  const GB = 1024 * 1024 * 1024
  const MB = 1024 * 1024
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`
  return `${Math.max(bytes / MB, 1).toFixed(0)} MB`
}

/**
 * Refuse before the first byte when the volume cannot hold the download. `availableBytes` is
 * `undefined` when the volume cannot be identified — then the check passes (an unidentifiable
 * volume is not a reason to block). Returns the tagged message, or `undefined` when there is room.
 */
export function checkFreeSpace(availableBytes: number | undefined, needed: number): string | undefined {
  if (needed === 0 || availableBytes === undefined) return undefined
  const required = needed + FREE_SPACE_HEADROOM
  if (availableBytes >= required) return undefined
  return diskFaultMessage(
    'disk_full',
    `Not enough free disk space: ${formatBytes(required)} needed, ${formatBytes(availableBytes)} available`
  )
}

/** Legacy Windows MAX_PATH; long-path support is not something a large share of installs has. */
export const WINDOWS_MAX_PATH = 260

/**
 * Reject a save path that will not survive the Windows path limit. The `.tmp` partial is the
 * longest name written, so that is the length checked. Verbatim paths (`\\?\`) are exempt.
 * No-op off Windows.
 */
export function checkPathWithinLimit(savePath: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== 'win32') return undefined
  if (savePath.startsWith('\\\\?\\')) return undefined
  const effective = Array.from(savePath).length + '.tmp'.length
  if (effective < WINDOWS_MAX_PATH) return undefined
  return diskFaultMessage(
    'disk_path_too_long',
    `File path is ${effective} characters, over the ${WINDOWS_MAX_PATH}-character Windows limit. Move the Atomic Chat data folder closer to the drive root and retry.`
  )
}
