/**
 * What is read out of `cloudflared`'s output. Pure.
 *
 * It prints the tunnel's name, and later a "Registered tunnel connection" line once an edge
 * connection is actually up. Until that second line the name answers with Cloudflare's error 1033,
 * so a URL alone is never treated as ready.
 *
 * Ported from: src-tauri/src/core/server/remote_access/process.rs (`OutputParser`), `767ff6350`.
 */

/** Printed once an edge connection is registered and the URL can serve. */
const REGISTERED_MARKER = 'Registered tunnel connection'

/**
 * cloudflared mentions its own control host in failure lines (`https://api.trycloudflare.com/tunnel`);
 * that is never a tunnel.
 */
const API_HOST = 'api.trycloudflare.com'

const TUNNEL_URL = /https:\/\/([A-Za-z0-9-]+\.trycloudflare\.com)/g

export interface ParsedOutput {
  url: string | undefined
  registered: boolean
}

/** A URL that can actually serve: minted *and* registered. */
export function readyUrl(parsed: ParsedOutput): string | undefined {
  return parsed.registered ? parsed.url : undefined
}

/**
 * Accumulates what the output has established. First URL wins: cloudflared prints it once, and a
 * later line must not swap the advertised address.
 */
export class OutputParser {
  private url: string | undefined
  private registered = false

  /** Returns `true` when this line changed what is known. */
  feedLine(line: string): boolean {
    let changed = false
    if (this.url === undefined) {
      for (const match of line.matchAll(TUNNEL_URL)) {
        if ((match[1] as string).toLowerCase() === API_HOST) continue
        this.url = match[0]
        changed = true
        break
      }
    }
    if (!this.registered && line.includes(REGISTERED_MARKER)) {
      this.registered = true
      changed = true
    }
    return changed
  }

  snapshot(): ParsedOutput {
    return { url: this.url, registered: this.registered }
  }
}
