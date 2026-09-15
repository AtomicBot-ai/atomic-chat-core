/**
 * Sharded GGUF sets (`-00001-of-000NN`). llama.cpp accepts only the first shard on `-m`.
 * Verbatim port of the shard helpers in `extensions/llamacpp-upstream-extension/src/util.ts`.
 *
 * The marker appears either in the file name (`Model-00002-of-00003.gguf`) or in the directory
 * name this app stores a downloaded shard under (`.../Model-00002-of-00003/model.gguf`).
 */

const GGUF_SHARD_RE = /-(\d{5})-of-(\d{5})(?=\.gguf$|\/|$)/gi

export interface GgufShardRef {
  /** 1-based position in the set. */
  index: number
  total: number
}

function matchGgufShard(path: string): (GgufShardRef & { start: number; end: number }) | null {
  GGUF_SHARD_RE.lastIndex = 0
  let last: RegExpExecArray | null = null
  for (let m = GGUF_SHARD_RE.exec(path); m; m = GGUF_SHARD_RE.exec(path)) last = m
  if (!last) return null
  const index = Number(last[1])
  const total = Number(last[2])
  if (!index || !total || index > total) return null
  return { index, total, start: last.index, end: last.index + last[0].length }
}

/** Shard position of `path`, or `null` for a standalone model. */
export function parseGgufShard(path: string): GgufShardRef | null {
  const m = matchGgufShard(path)
  return m ? { index: m.index, total: m.total } : null
}

/** The same path with its marker pointed at `index`; unchanged without a marker. */
export function ggufShardPath(path: string, index: number): string {
  const m = matchGgufShard(path)
  if (!m) return path
  const marker = `-${String(index).padStart(5, '0')}-of-${String(m.total).padStart(5, '0')}`
  return path.slice(0, m.start) + marker + path.slice(m.end)
}

/** Every path of the set, first shard first; a standalone model yields itself. */
export function ggufShardSetPaths(path: string): string[] {
  const m = matchGgufShard(path)
  if (!m) return [path]
  return Array.from({ length: m.total }, (_, i) => ggufShardPath(path, i + 1))
}

/** What llama.cpp must be handed: the first shard, or the path itself. */
export function firstGgufShardPath(path: string): string {
  return ggufShardPath(path, 1)
}
