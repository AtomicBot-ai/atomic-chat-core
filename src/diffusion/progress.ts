/**
 * Reading `sd-server`'s verbose output: sampling progress, and the part of a dead server's output
 * worth showing. Port of `progress.rs` in `tauri-plugin-atomic-diffusion` (app commit `767ff6350`).
 *
 * sd.cpp redraws its progress bar in place: each redraw is `"\r<bar> <step>/<steps> - <speed>ESC[K"`,
 * with a newline only on the last step of a phase. The carriage return *leads* a record and the
 * erase-to-end-of-line closes it, so keying on CR/LF alone delivers every step one redraw late.
 */

import { StringDecoder } from 'node:string_decoder'

const ANSI_ERASE = '\x1b[K'

/**
 * Complete records, and the unterminated remainder the caller carries into the next chunk. A record
 * ends at `\r`, `\n`, `\r\n` (one terminator, not two) or a trailing `ESC[K`. Records still contain
 * their escapes: see `stripAnsi`.
 */
export function splitRecords(buf: string): { records: string[]; rest: string } {
  const records: string[] = []
  let start = 0
  let i = 0
  while (i < buf.length) {
    const c = buf[i]
    if (c === '\r' || c === '\n') {
      records.push(buf.slice(start, i))
      if (c === '\r' && buf[i + 1] === '\n') i += 1
      i += 1
      start = i
      continue
    }
    if (buf.startsWith(ANSI_ERASE, i)) {
      i += ANSI_ERASE.length
      records.push(buf.slice(start, i))
      start = i
      continue
    }
    i += 1
  }
  return { records, rest: buf.slice(start) }
}

/** Drop CSI escape sequences (`ESC [`, parameters, intermediates, one final byte `@`–`~`). */
export function stripAnsi(text: string): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    if (text[i] === '\x1b' && text[i + 1] === '[') {
      i += 2
      while (i < text.length) {
        const code = text.charCodeAt(i)
        i += 1
        if (code >= 0x40 && code <= 0x7e) break
      }
      continue
    }
    out += text[i]
    i += 1
  }
  return out
}

/**
 * One pipe of the server, from raw chunks to the lines worth reading: UTF-8 decoded across chunk
 * boundaries (a split multibyte character waits for its continuation, invalid bytes become U+FFFD),
 * split into records, escapes stripped, trailing whitespace trimmed, empty lines dropped.
 */
export class OutputRecords {
  private readonly decoder = new StringDecoder('utf8')
  private pending = ''

  push(chunk: Buffer): string[] {
    const { records, rest } = splitRecords(this.pending + this.decoder.write(chunk))
    this.pending = rest
    return records.map(cleanRecord).filter((line) => line !== '')
  }

  /** Whatever is left when the pipe closes. */
  finish(): string[] {
    const last = cleanRecord(this.pending + this.decoder.end())
    this.pending = ''
    return last === '' ? [] : [last]
  }
}

function cleanRecord(record: string): string {
  return stripAnsi(record).trimEnd()
}

const isDigit = (code: number): boolean => code >= 0x30 && code <= 0x39
// Rust's `is_ascii_whitespace`: space, tab, line feed, form feed, carriage return.
const isAsciiWhitespace = (code: number): boolean =>
  code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d

function parseU32(digits: string): number | undefined {
  const value = Number(digits)
  return value <= 0xffff_ffff ? value : undefined
}

/**
 * `[step, total]` from a sampling-progress line such as `|====>   | 12/28 - 3.5s/it` or `[ 12/ 28]`:
 * the first `N/M` pair in the line. The caller trusts it only when `M` is the step count it expects,
 * so a stray `1/100` from a loader cannot move the bar.
 */
export function parseStepLine(line: string): [number, number] | undefined {
  const n = line.length
  let i = 0
  while (i < n) {
    if (!isDigit(line.charCodeAt(i))) {
      i += 1
      continue
    }
    const numStart = i
    while (i < n && isDigit(line.charCodeAt(i))) i += 1
    const step = parseU32(line.slice(numStart, i))
    if (step === undefined) continue
    let j = i
    while (j < n && isAsciiWhitespace(line.charCodeAt(j))) j += 1
    if (j >= n || line[j] !== '/') continue
    j += 1
    while (j < n && isAsciiWhitespace(line.charCodeAt(j))) j += 1
    const denStart = j
    while (j < n && isDigit(line.charCodeAt(j))) j += 1
    if (denStart === j) continue
    const total = parseU32(line.slice(denStart, j))
    if (total !== undefined) return [step, total]
  }
  return undefined
}

/**
 * One redraw of sd.cpp's progress bar (sampling, VAE tiles or a tensor loader), as opposed to a
 * line that says something. They all close with a rate: `- 3.52s/it`, `- 1.41it/s`, `- 637.50MB/s`.
 */
export function isProgressRedraw(line: string): boolean {
  return ['s/it', 'it/s', 'B/s'].some((rate) => line.includes(rate))
}

/**
 * The tile count from sd.cpp's `processing 9 tiles`, printed before a tiled VAE pass. The pass then
 * redraws the sampler's own bar (`3/9 - 1.3s/it`), so without this nine tiles read as nine steps.
 */
export function parseTileAnnouncement(line: string): number | undefined {
  const rest = line.split('processing ')[1]
  if (rest === undefined) return undefined
  const space = rest.indexOf(' ')
  if (space < 0) return undefined
  if (
    !rest
      .slice(space + 1)
      .trimStart()
      .startsWith('tiles')
  )
    return undefined
  const count = rest.slice(0, space)
  return /^\+?\d+$/.test(count) ? parseU32(count) : undefined
}

/** Lines worth keeping from a dead server's output, whatever their position. */
const DIAGNOSTIC_MARKERS = [
  'error',
  'abort',
  'assert',
  'unsupported',
  'not implemented',
  'out of memory',
  'failed',
  'exception',
]

export const DIAGNOSTIC_KEEP = 20
export const DIAGNOSTIC_LIMIT = 1500

/**
 * The most useful part of the captured output, not merely its end. A native abort prints its reason
 * first and then a long backtrace, so the last N lines are nothing but stack frames. Marked lines
 * come first (in order), then the last few lines for context, de-duplicated, capped at `limit`
 * characters.
 */
export function diagnosticTail(
  lines: readonly string[],
  keep = DIAGNOSTIC_KEEP,
  limit = DIAGNOSTIC_LIMIT
): string {
  const marked = lines.filter((line) => {
    const lower = line.toLowerCase()
    return DIAGNOSTIC_MARKERS.some((marker) => lower.includes(marker))
  })
  const markedTail = marked.slice(Math.max(marked.length - keep, 0))
  const context = Math.max(Math.floor(keep / 2), 4)
  const contextTail = lines.slice(Math.max(lines.length - context, 0))
  const chosen = [...new Set([...markedTail, ...contextTail])]
  return [...chosen.join('\n')].slice(0, limit).join('')
}

/**
 * Why a server process died, from its exit code and captured output. `code` is the exit code, or
 * `128 + signal number` for a signal (137 is a SIGKILL, which is what the kernel's OOM killer sends).
 */
export function classifyExit(tail: string, code: number | undefined): 'OUT_OF_MEMORY' | 'ENGINE_CRASHED' {
  const lower = tail.toLowerCase()
  const outOfMemory =
    code === 137 ||
    lower.includes('out of memory') ||
    lower.includes('failed to allocate') ||
    lower.includes('cudaerrormemoryallocation') ||
    lower.includes('insufficient memory') ||
    // sd.cpp's model manager, when a graph (the Wan VAE decoding a long clip on Metal, seen
    // 2026-09-23 at 27.6 GB against 14.9 GB) does not fit: the job fails, the server lives on.
    lower.includes('cannot make enough memory available')
  return outOfMemory ? 'OUT_OF_MEMORY' : 'ENGINE_CRASHED'
}

/**
 * GPU faults sd.cpp can outlive while its Metal backend stays broken: an address fault, a backend
 * left in its error state, or a command buffer that page-faulted. Fed the lines of one attempt;
 * the two halves of the last kind may arrive on different lines. `fatal_gpu_error_since` in
 * `jobs.rs` (app commit `ec1fd3ea7`), which reads the same markers from the server's tail.
 */
export class GpuFaultWatch {
  private fault = false
  private commandBuffer = false
  private pagefault = false

  onLine(line: string): void {
    const lower = line.toLowerCase()
    if (lower.includes('gpu address fault') || lower.includes('backend is in error state')) this.fault = true
    if (lower.includes('command buffer')) this.commandBuffer = true
    if (lower.includes('pagefault')) this.pagefault = true
  }

  get tripped(): boolean {
    return this.fault || (this.commandBuffer && this.pagefault)
  }
}
