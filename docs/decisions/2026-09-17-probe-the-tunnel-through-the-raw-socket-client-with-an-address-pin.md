---
date: 2026-09-17
title: "Probe the tunnel through the raw-socket client with an address pin"
---

# 2026-09-17 — Probe the tunnel through the raw-socket client with an address pin

- **Context:** A registered tunnel is not yet reachable: its public name still has to propagate, and until then a visitor gets Cloudflare's error page. The app proves the URL before showing it, and goes through Cloudflare's edge *by SNI* first — the edge routes on the TLS server name, so it serves the tunnel before the hostname resolves anywhere, while an early OS lookup would negative-cache the NXDOMAIN and blind every later attempt. In Rust that is reqwest's `resolve(host, addr)`. In the core the equivalent on `node:https` would be an agent or `lookup` override, which `2026-09-15-proxied-downloads-use-a-raw-socket-client` already found Bun to ignore silently.
- **Decision:** `ProxyPolicy.connectTo {host, port?}` on the existing raw-socket client dials that address while the TLS server name, certificate verification and `Host` stay the URL's. The probe fetches `<url>/openapi.json` (whitelisted: no key, no Host check), accepts only a JSON document whose `info.title` is this server's, caps the body at 256 KiB, gives each attempt 5 s on a fresh connection, tries at most two edge addresses (IPv4 first) for up to 15 s with 500 ms between rounds and gives up the edge after two rounds with no answer at all, then falls back to the hostname inside the same 45 s budget.
- **Consequences:** one HTTP client for every outbound path that must behave the same under Node, Bun and the compiled binary. The probe dials directly, so a network that only reaches the internet through a mandatory proxy ends in `not_reachable` (reqwest honoured system proxies); an optional proxy on start is a possible follow-up.
- **Owner:** team.
- **Links:** `src/remote-access/probe.ts`, `src/downloads/proxy-fetch.ts`; app source `remote_access/probe.rs` at `767ff6350`.
