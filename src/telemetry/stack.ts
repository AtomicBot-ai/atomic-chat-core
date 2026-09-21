/** One Sentry stack frame. */
export interface StackFrame {
  function?: string
  filename: string
  lineno?: number
  colno?: number
  /** Ours (`src/…`), not the runtime's or a dependency's. */
  in_app: boolean
}

const MAX_FRAMES = 50

/**
 * Where a frame's file lives, without the machine it was built or run on. The compiled binary
 * already reports repo-relative `src/…` paths (Bun embeds the source map); under Node the path is
 * absolute and is cut at `src/` or `dist/`; anything else keeps only its file name, which drops the
 * home folder and the user name with it. Runtime pseudo-files (`native`, `node:internal/…`) stay.
 */
export function framePath(raw: string): string {
  let path = raw.replace(/^file:\/\/\/?/, '/').replace(/\\/g, '/')
  if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1)
  if (path === 'native' || path.startsWith('node:') || path.startsWith('src/')) return path
  const dependency = /(?:^|\/)(node_modules\/.+)$/.exec(path)
  if (dependency?.[1]) return dependency[1]
  // The last `src/` or `dist/`: a checkout under `~/src/` must not keep that prefix.
  const cut = /^.*(?:^|\/)((?:src|dist)\/.+)$/.exec(path)
  if (cut?.[1]) return cut[1]
  return path.slice(path.lastIndexOf('/') + 1)
}

function parseLocation(location: string): { path: string; line?: number; column?: number } {
  const match = /^(.*?)(?::(\d+))?(?::(\d+))?$/.exec(location) as RegExpExecArray
  const [, path = '', line, column] = match
  return {
    path,
    ...(line ? { line: Number(line) } : {}),
    ...(column ? { column: Number(column) } : {}),
  }
}

/**
 * Parse a V8- or JavaScriptCore-style `error.stack` into Sentry frames, oldest call first (the order
 * Sentry expects; `error.stack` lists the innermost call first).
 */
export function parseStack(stack: string | undefined): StackFrame[] {
  if (!stack) return []
  const frames: StackFrame[] = []
  for (const line of stack.split('\n')) {
    const at = /^\s*at\s+(.+?)\s*$/.exec(line)
    if (!at?.[1]) continue
    const body = at[1]
    let fn: string | undefined
    let location = body
    const open = body.lastIndexOf(' (')
    if (open > 0 && body.endsWith(')')) {
      fn = body.slice(0, open).replace(/^async\s+/, '')
      location = body.slice(open + 2, -1)
    }
    const { path, line: lineno, column } = parseLocation(location)
    if (!path) continue
    const filename = framePath(path)
    frames.push({
      ...(fn ? { function: fn } : {}),
      filename,
      ...(lineno !== undefined ? { lineno } : {}),
      ...(column !== undefined ? { colno: column } : {}),
      in_app: filename.startsWith('src/') || filename.startsWith('dist/'),
    })
    if (frames.length === MAX_FRAMES) break
  }
  return frames.reverse()
}
