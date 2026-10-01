/**
 * Masks the value that follows `--api-key` in an argv list, so a log line built from `args` (the
 * engine start line, `core-log/spec.md`) never carries the key itself. Handles both the two-token
 * form (`--api-key`, `<value>`) and the single-token `--api-key=<value>` form. Every other argument
 * passes through unchanged.
 */
export function redactArgs(args: readonly string[]): string[] {
  const redacted: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === undefined) continue
    if (arg.startsWith('--api-key=')) {
      redacted.push('--api-key=<redacted>')
      continue
    }
    if (arg === '--api-key' && args[i + 1] !== undefined) {
      redacted.push(arg, '<redacted>')
      i++
      continue
    }
    redacted.push(arg)
  }
  return redacted
}
