/**
 * Zero-PII scrubbing for everything an error report carries. A port of the app's
 * `src-tauri/src/core/telemetry/scrub.rs` (itself a mirror of `scrubPii` in the web app), plus what
 * only the core sees: its data folder, the tunnel host, LAN addresses and more token shapes.
 * Structure is kept so a report stays debuggable: `/Users/<redacted>/models/x.gguf`, not `<path>`.
 */

export interface ScrubContext {
  /** The canonical data folder; every path under it becomes `<data>/…`. */
  dataFolder?: string
  /** The user's home folder; becomes `~`. */
  homeDir?: string
}

export const REDACTED = '<redacted>'

/** Object keys whose values are dropped wholesale — the web app's `SENSITIVE_KEY_RE`. */
const SENSITIVE_KEY_RE =
  /^(authorization|cookie|set-cookie|x-api-key|api[_-]?key|token|access_token|refresh_token|auth|secret|password|passwd|base_url|hf_token|huggingface_token|proxy|email|username|user_name|ip|ip_address|serial|uuid|hostname|host_name|machine|machine_name)$/i

const RULES: ReadonlyArray<readonly [RegExp, string]> = [
  // The first segment after a home-folder marker is the OS user name.
  [/([/\\](?:Users|home)[/\\])[^/\\\s"'`)\]},;:|]+/g, `$1${REDACTED}`],
  // `scheme://user:pass@host` keeps the scheme and the host.
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]+@/gi, `$1${REDACTED}@`],
  // A quick tunnel's name is the only thing that guards it.
  [/\b[a-z0-9-]+\.trycloudflare\.com\b/gi, '<tunnel>.trycloudflare.com'],
  [/\bhf_[A-Za-z0-9_]+/g, REDACTED],
  [/\bsk-ant-[\w-]+/g, REDACTED],
  [/\bsk-[\w-]{10,}/g, REDACTED],
  [/\bAIza[\w-]{20,}/g, REDACTED],
  [/\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]+/g, REDACTED],
  [/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, REDACTED],
  [/(\bbearer\s+)[^\s"']+/gi, `$1${REDACTED}`],
  [
    /([?&](?:access_token|refresh_token|api_key|apikey|password|secret|signature|token|auth|key|sig)=)[^&#"'\s]*/gi,
    `$1${REDACTED}`,
  ],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>'],
  // LAN and public addresses; loopback and the wildcard say nothing about the user.
  [
    /\b(?!127\.0\.0\.1\b)(?!0\.0\.0\.0\b)(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g,
    '<ip>',
  ],
]

function replaceFolder(input: string, folder: string | undefined, token: string): string {
  if (!folder || folder.length < 2) return input
  let out = input
  for (const variant of new Set([folder, folder.replace(/\\/g, '/'), folder.replace(/\//g, '\\')])) {
    out = out.split(variant).join(token)
  }
  return out
}

/** Mask user names, credentials, tokens, e-mail and network addresses in free text. */
export function scrubText(input: string, context: ScrubContext = {}): string {
  let out = replaceFolder(input, context.dataFolder, '<data>')
  out = replaceFolder(out, context.homeDir, '~')
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement)
  return out
}

/** Scrub every string in a JSON-like value; values under sensitive keys are dropped wholesale. */
export function scrubValue(value: unknown, context: ScrubContext = {}): unknown {
  if (typeof value === 'string') return scrubText(value, context)
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, context))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY_RE.test(key) ? REDACTED : scrubValue(item, context)
    }
    return out
  }
  return value
}

/** The first non-empty line, cut to `max` characters: an engine's headline, not its pasted log. */
export function headline(text: string, max = 200): string {
  const line =
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean) ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}
