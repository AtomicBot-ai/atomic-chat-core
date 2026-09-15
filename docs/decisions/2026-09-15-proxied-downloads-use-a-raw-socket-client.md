---
date: 2026-09-15
title: "Proxied downloads use a raw-socket HTTP client, not undici or agent overrides"
status: accepted 2026-09-15 (owner: "1. a"); implemented in src/downloads/proxy-fetch.ts
---

# 2026-09-15 — Proxied downloads use a raw-socket HTTP client, not undici or agent overrides

- **Context:** The app lets a download carry a proxy policy (`ProxyConfig`:
  `{url, username, password, no_proxy, ignore_ssl}`, `src-tauri/src/core/downloads/models.rs:48`),
  applied per request through reqwest. The core's downloader runs on the runtime's built-in `fetch`
  and exposes the seam `DownloaderDeps.fetchFor(item)`. Risk 13 asked whether that seam can honour
  the policy on both Node and the compiled Bun binary without new dependencies. The spike
  (`docs/spikes/2026-09-15-proxied-downloads-node-vs-bun.md`) measured five mechanisms across
  19 cases (HTTP forward, CONNECT, proxy auth, SOCKS5, `no_proxy` host/suffix/CIDR, invalid TLS,
  custom CA, client cert, Range/206 through the tunnel, abort, redirects) on Node 22/24/25,
  Bun 1.3.14 and the `bun build --compile` binary.
- **Decision:** Proxied items get a fetch built by `createPolicyFetch(policy)` in
  `src/downloads/proxy-fetch.ts`: a ~280-line HTTP/1.1 client over `node:net`/`node:tls` that
  speaks CONNECT and SOCKS5 (RFC 1929 auth) itself and applies `ignore_ssl`/CA/cert via
  `tls.connect`. Unproxied items keep the global `fetch`, so nothing changes for them. No
  dependency is added. Rejected: an explicit `undici` dependency (works only through
  `undici.fetch` on Node and is replaced by an empty stub inside Bun, so it never covers the
  shipped binary); `https.Agent.createConnection` overrides (Bun never calls them and silently
  bypasses the proxy); `HTTPS_PROXY`/`NODE_EXTRA_CA_CERTS` env vars (process-global, no client
  cert, SOCKS only on Node 24+, different `NO_PROXY` semantics); Bun's `fetch({proxy, tls})`
  (Bun-only API, no SOCKS).
- **Consequences:** Proxied downloads are HTTP/1.1, one connection per request, no content
  encoding; that matches what reqwest does for these transfers. Tests must assert that the
  proxy observed the connection, not merely that the file arrived, because the silent-bypass
  failure mode exists on Bun. Fixture proxy/SOCKS/TLS servers from the spike are ported into
  `test/helpers/` and the suite runs under Node and under the compiled binary. SOCKS4 is
  accepted by the app's validator but implemented nowhere; the core keeps rejecting it unless
  the owner decides otherwise. Custom CA and client certificates are supported by the mechanism
  but stay out of the policy until the app grows a setting for them.
- **Owner:** team
- **Links:** `docs/spikes/2026-09-15-proxied-downloads-node-vs-bun.md`, `src/downloads/protocol.ts`
  (`validateProxyConfig`, `shouldBypassProxy`), `src/downloads/downloader.ts` (`fetchFor`),
  PLAN.md §6 risk 13, §8.3.
