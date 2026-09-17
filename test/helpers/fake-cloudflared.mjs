#!/usr/bin/env node
/**
 * A stand-in for `cloudflared`, close enough that the core cannot tell the difference: it prints
 * the lines the real binary prints on stderr, and can fail the ways a tunnel fails.
 *
 * Driven by env:
 *   FAKE_CLOUDFLARED_MODE       url-then-registered | url-only | registers-only-on-http2 | silent |
 *                               exit-immediately | ready-then-exit | ignore-sigterm
 *   FAKE_CLOUDFLARED_URL        the tunnel URL to print (default https://calm-river-demo.trycloudflare.com)
 *   FAKE_CLOUDFLARED_ARGV_FILE  path; `{argv, tunnelEnv}` is appended there as one JSON line, so a test
 *                               can assert the command line and that no TUNNEL_* variable leaked in
 */
import { appendFileSync } from 'node:fs'

const mode = process.env.FAKE_CLOUDFLARED_MODE ?? 'url-then-registered'
const url = process.env.FAKE_CLOUDFLARED_URL ?? 'https://calm-river-demo.trycloudflare.com'
const argv = process.argv.slice(2)

if (process.env.FAKE_CLOUDFLARED_ARGV_FILE) {
  const tunnelEnv = Object.keys(process.env).filter((key) => key.toUpperCase().startsWith('TUNNEL_'))
  appendFileSync(
    process.env.FAKE_CLOUDFLARED_ARGV_FILE,
    `${JSON.stringify({ argv, tunnelEnv, pid: process.pid })}\n`
  )
}

const say = (line) => process.stderr.write(`${line}\n`)
const banner = '2026-09-17T10:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...'
const urlLine = `2026-09-17T10:00:01Z INF |  ${url}  |`
const registered = '2026-09-17T10:00:02Z INF Registered tunnel connection connIndex=0 protocol=quic'
const stay = () => setInterval(() => {}, 1 << 30)

switch (mode) {
  case 'url-then-registered':
    say(banner)
    say(urlLine)
    say(registered)
    stay()
    break
  case 'url-only':
    say(banner)
    say(urlLine)
    stay()
    break
  case 'registers-only-on-http2': {
    // What a network that drops QUIC looks like: a URL, and a registration only over HTTP/2.
    say(banner)
    say(urlLine)
    const protocol = argv[argv.indexOf('--protocol') + 1]
    if (argv.includes('--protocol') && protocol === 'http2') say(registered.replace('quic', 'http2'))
    stay()
    break
  }
  case 'silent':
    stay()
    break
  case 'exit-immediately':
    say('failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": EOF')
    process.exit(1)
    break
  case 'ready-then-exit':
    say(urlLine)
    say(registered)
    setTimeout(() => process.exit(0), 300)
    break
  case 'ignore-sigterm':
    process.on('SIGTERM', () => {})
    say(urlLine)
    say(registered)
    stay()
    break
  default:
    process.stderr.write(`unknown fake cloudflared mode ${mode}\n`)
    process.exit(2)
}
