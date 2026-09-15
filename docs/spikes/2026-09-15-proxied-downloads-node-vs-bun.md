# Proxy spike — can `atomic-chat-core`'s downloader honour the app's proxy/TLS settings with built-in `fetch`?

PLAN.md §6 risk 13 / §8.3. Copied verbatim from the scratch spike (`scratchpad/proxy-spike/`, servers and probes not kept). Nothing in either repo was modified; nothing installed globally
(`npm install undici` only in `./with-undici/`).

## TL;DR

- **Yes on both runtimes, with zero new dependencies — but not with `fetch` alone.** Global `fetch` covers the
  full matrix on Bun *except SOCKS*, and covers nothing per-request on Node 22 (no `dispatcher` reachable without a
  package). The one mechanism that passes every case (a–i) on **Node 22/24/25, Bun 1.3.14 and the
  `bun build --compile` binary** is a ~280-line dependency-free HTTP/1.1 client over `node:net`/`node:tls`
  (`tunnel.mjs` + `mech-raw-socket.mjs`), used **only for items that carry a proxy/TLS policy**; everything else
  keeps global `fetch`.
- **An explicit `undici` dependency does not help the shipped product.** Bun replaces `undici` with a built-in stub
  (`ProxyAgent` is an empty class) even when the npm package is in `node_modules`; loading it by file path fails
  (`webidl.util.markAsUncloneable is not a function`); and Bun's `fetch` ignores `dispatcher`. On Node it works only
  through `undici.fetch`, not the global `fetch` (`UND_ERR_INVALID_ARG: invalid onRequestStart method` — version
  mismatch between npm undici 8 and Node's bundled 6.x). So undici would be a Node-only path plus a second Bun path.
- **Bun silently bypasses the proxy** when you try the classic `Agent.createConnection` override (Bun's `node:http`
  never calls it) — the request goes direct and succeeds. That is the failure mode to guard against with a test that
  asserts the proxy *saw* the connection, not just that the download succeeded.
- **Scope check against the app:** the app's `ProxyConfig` (`src-tauri/src/core/downloads/models.rs:48`) is
  `{url, username, password, no_proxy, ignore_ssl}` only; reqwest is built with `.proxy()` +
  `.danger_accept_invalid_certs()` (`helpers.rs:373-407`). There is **no custom-CA, client-cert or CIDR support in the
  app today**; `no_proxy` is `*` / `*.suffix` (bare `endsWith`) / exact host. Those cases (g, h, e3) were probed anyway
  and all pass with the recommended mechanism, so adding them later is policy-only.

## Environment

| | |
|---|---|
| Node | v22.22.0 (bundled undici 6.23.0); cross-checked v24.15.0 (undici 7.24.4), v25.7.0 (undici 7.21.0) via volta |
| Bun | 1.3.14 (macOS arm64), runtime and `bun build --compile` binary |
| npm undici (scratch only) | 8.10.2 in `./with-undici/node_modules` |
| Core repo | `undici@5.29.0` is already present **transitively** (`@ai-sdk/provider-utils` → `undici ^5.29.0`); `import 'undici'` resolves in the core today by accident, not by contract |

Test servers (`servers.mjs`, plain Node, no deps): http origin, https origin (cert signed by a spike CA, SAN
`localhost`/`127.0.0.1`), mTLS origin (`requestCert: true`), self-signed origin, HTTP forward+CONNECT proxy (open and
Basic-auth), HTTPS proxy (TLS to the proxy), SOCKS5 proxy (RFC 1928, open and RFC 1929 user/pass), and a `/stats`
endpoint recording every proxy event so a PASS means "the proxy actually carried it". `/big` streams 8 MiB and honours
`Range`. Certs from `openssl` (`certs/`). Rerun everything: `node servers.mjs &` then `./run-all.sh`,
`node redirect-probe.mjs raw-socket`, `bun redirect-probe.mjs raw-socket`.

## Cases

| id | case |
|---|---|
| a | HTTP proxy, `http://` target (absolute-URI forward) |
| b / b2 | HTTP CONNECT proxy, `https://` target, with custom CA / with `ignore_ssl` |
| c / c2 | Proxy Basic auth, `http://` target (forward) / `https://` target (CONNECT) |
| d / d2 / d3 | SOCKS5: `http://` target / `https://` target + CA / user-pass auth |
| e1 / e2 / e3 / e4 | `no_proxy` exact host / `*.suffix` / CIDR `127.0.0.0/8` / non-matching entry still proxies |
| f / f-neg | `ignore_ssl` against self-signed origin / **negative**: must fail without it |
| g / g-neg | custom CA PEM / **negative**: must fail without it |
| h / h-neg | client cert + key against mTLS origin / **negative**: must fail without it |
| i | HTTPS proxy (TLS to the proxy itself, CA-verified), CONNECT, `https://` target |

## Results matrix (mechanism × case × runtime)

Generated from `results.jsonl` by `matrix.mjs`. `n/s` = UNSUPPORTED (mechanism not available on that runtime).
¹ = passed, but the mechanism used a CONNECT tunnel even for a plain `http://` target (undici/Bun-env semantics;
reqwest would send an absolute-URI GET — some corporate proxies only allow CONNECT to :443).

| mechanism | runtime | a | b | b2 | c | c2 | d | d2 | d3 | e1 | e2 | e3 | e4 | f | f-neg | g | g-neg | h | h-neg | i |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| builtin-agent | node 22.22.0 | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| raw-socket | node 22.22.0 | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| global-dispatcher-hack | node 22.22.0 | PASS¹ | PASS | PASS | PASS¹ | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS¹ | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| env-vars | node 22.22.0 | PASS¹ | PASS | PASS | PASS¹ | PASS | FAIL | FAIL | FAIL | PASS | FAIL | FAIL | PASS¹ | PASS | PASS | PASS | PASS | n/s | PASS | PASS |
| builtin-agent | bun 1.3.14 | PASS | FAIL | FAIL | PASS | FAIL | FAIL | FAIL | FAIL | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | FAIL |
| raw-socket | bun 1.3.14 | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| bun-fetch | bun 1.3.14 | PASS | PASS | PASS | PASS | PASS | FAIL | FAIL | FAIL | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| global-dispatcher-hack | bun 1.3.14 | n/s | n/s | n/s | n/s | n/s | n/s | n/s | n/s | n/s | n/s | n/s | n/s | n/s | n/s | n/s | n/s | n/s | n/s | n/s |
| env-vars | bun 1.3.14 | PASS | PASS | PASS | PASS | PASS | FAIL | FAIL | FAIL | PASS | FAIL | FAIL | PASS | PASS | PASS | PASS | PASS | n/s | PASS | PASS |
| undici-npm/global-fetch | node 22.22.0 | FAIL | FAIL | FAIL | FAIL | FAIL | FAIL | FAIL | FAIL | FAIL | FAIL | FAIL | FAIL | FAIL | PASS | FAIL | PASS | FAIL | PASS | FAIL |
| undici-npm/undici-fetch | node 22.22.0 | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| undici-npm/global-fetch | bun 1.3.14 | n/s | n/s | n/s | n/s | n/s | n/s | n/s | n/s | n/s | n/s | n/s | n/s | n/s | n/s | n/s | n/s | n/s | n/s | n/s |
| undici-npm-bypath/undici-fetch | bun 1.3.14 | FAIL | FAIL | FAIL | FAIL | FAIL | FAIL | FAIL | FAIL | FAIL | FAIL | FAIL | FAIL | FAIL | PASS | FAIL | PASS | FAIL | PASS | FAIL |
| builtin-agent | node 24.15.0 | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| raw-socket | node 24.15.0 | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| global-dispatcher-hack | node 24.15.0 | PASS¹ | PASS | PASS | PASS¹ | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS¹ | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| env-vars | node 24.15.0 | PASS¹ | PASS | PASS | PASS¹ | PASS | PASS | PASS | PASS | PASS | PASS | FAIL | PASS¹ | PASS | PASS | PASS | PASS | n/s | PASS | PASS |
| builtin-agent | node 25.7.0 | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| raw-socket | node 25.7.0 | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| global-dispatcher-hack | node 25.7.0 | PASS¹ | PASS | PASS | PASS¹ | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS¹ | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| env-vars | node 25.7.0 | PASS¹ | PASS | PASS | PASS¹ | PASS | FAIL | FAIL | FAIL | PASS | FAIL | FAIL | PASS¹ | PASS | PASS | PASS | PASS | n/s | PASS | FAIL |
| raw-socket | bun 1.3.14 (compiled) | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| bun-fetch | bun 1.3.14 (compiled) | PASS | PASS | PASS | PASS | PASS | FAIL | FAIL | FAIL | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| builtin-agent | bun 1.3.14 (compiled) | PASS | FAIL | FAIL | PASS | FAIL | FAIL | FAIL | FAIL | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | FAIL |

Reading the matrix:

| mechanism | what it is | verdict |
|---|---|---|
| **raw-socket** | HTTP/1.1 over `node:net`/`node:tls`; CONNECT and SOCKS5 written by hand; `tls.connect({socket, ca, cert, key, rejectUnauthorized})` | **19/19 on Node 22, 24, 25, Bun, compiled Bun.** Also passes streaming/Range/abort and redirect/HEAD probes below. |
| bun-fetch | Bun `fetch(url, { proxy, tls })` | 16/19 on Bun: everything except SOCKS5 (`UnsupportedProxyProtocol`). Bun-only — a type error under the core's `types: ["node"]`. |
| builtin-agent | `node:https` + `Agent.createConnection` override (https-proxy-agent pattern) | 19/19 on Node. **On Bun every tunnelled case "succeeds" with zero proxy events = silent proxy bypass.** Also no redirect following and HEAD returns a stream. |
| global-dispatcher-hack | Node-only, undocumented: `globalThis[Symbol.for('undici.globalDispatcher.1')].constructor` → bundled `Agent`, `new Agent({ connect })` | 19/19 on Node 22/24/25, n/s on Bun. Works but rests on an unexported symbol and on the global dispatcher being a plain `Agent` (it is not once `--use-env-proxy` is set). |
| undici-npm / undici-fetch | `import { ProxyAgent, Agent, fetch } from 'undici'` (8.10.2) | 19/19 on Node, **only via `undici.fetch`**. Native SOCKS5 incl. auth (experimental warning). |
| undici-npm / global-fetch | same dispatcher passed to Node's global `fetch` | 0/19: `UND_ERR_INVALID_ARG invalid onRequestStart method` (bundled 6.x fetch cannot drive an 8.x dispatcher). |
| undici-npm on Bun | by name / by file path | n/s (Bun substitutes its stub) / FAIL (`webidl.util.markAsUncloneable is not a function`). **undici cannot be made to work on Bun.** |
| env-vars | `--use-env-proxy` + `HTTP(S)_PROXY`/`NO_PROXY`, `NODE_EXTRA_CA_CERTS`, `NODE_TLS_REJECT_UNAUTHORIZED=0` | Process-global, per-process not per-item; SOCKS only on Node 24.15 (bundled undici ≥7.24); `NO_PROXY` semantics differ from the app's (`*.localhost` does not match `localhost`, no CIDR); no client cert. Last resort only. |

### Downloader-shaped checks (`stream-results.jsonl`, `redirect-results.jsonl`)

Through the CONNECT proxy and through SOCKS5 to the CA-signed https origin: `Range: bytes=1048576-` → 206 with
correct `Content-Range`, 7 340 032 streamed bytes, mid-stream `AbortController.abort()` rejects the reader with
`AbortError` within ~4 ms.

| mechanism | runtime | Range/206 + stream | abort | same-origin 302 | cross-origin 307 (hop host in `no_proxy`) | redirect loop | HEAD body null |
|---|---|---|---|---|---|---|---|
| raw-socket | node 22 | PASS | AbortError | PASS | PASS (hop went direct, 1 SOCKS event) | rejected | PASS |
| raw-socket | bun 1.3.14 | PASS | AbortError | PASS | PASS | rejected | PASS |
| bun-fetch | bun | PASS (reused the tunnel for the 2nd request) | AbortError | PASS | n/s (SOCKS) | rejected | body is a stream (harmless: HEAD only reads `content-length`) |
| global-dispatcher-hack | node 22 | PASS | AbortError | PASS | FAIL: bypass decided once per dispatcher, hop still went via SOCKS | rejected | PASS |
| builtin-agent | node 22 | PASS | `ECONNRESET` instead of AbortError (cosmetic: downloader checks `signal.aborted` itself) | no redirect following at all | — | — | body is a stream |
| undici-npm/undici-fetch | node 22 | PASS | AbortError | not probed | not probed | not probed | not probed |

## Facts that constrain the design

1. **Bun's `undici` is a stub.** `bun -e "require('undici').ProxyAgent.toString()"` → `class ProxyAgent extends DispatcherBase { constructor() { super() } }`, and this substitution wins over `node_modules/undici`. Requiring the package by absolute file path loads the real code but its fetch crashes on a missing Node internal.
2. **Bun never calls `Agent.createConnection` / `createConnection` option** (`bun-caps.mjs`: 0 calls, Node: 1 call). Any "agent"-style library (`https-proxy-agent`, `socks-proxy-agent`) therefore *silently* bypasses the proxy on Bun.
3. **Bun does support** `tls.connect({ socket })` over an existing socket (authorized=true with the spike CA), `Readable.toWeb`, and `ca/cert/key` on `https.request`. That is what makes the raw-socket client possible on Bun.
4. **Node 22 global `fetch`** has no per-request proxy/TLS hook without `undici` classes; `node:undici` and `--expose-internals` are not options; the global-dispatcher symbol is the only in-process handle and it is undocumented.
5. `node --use-env-proxy` exists on 22.22 (backport) but is process-global; `NODE_USE_ENV_PROXY=1` also works. Bun honours `HTTP(S)_PROXY`/`NO_PROXY` natively. Neither is per-item.
6. Node's global `fetch` rejects a dispatcher from a different undici major (`invalid onRequestStart method`). An explicit undici dependency implies calling `undici.fetch`, i.e. a second fetch implementation in the process.
7. The core's `DownloaderDeps` already has the seam: `fetchFor?: (item, base) => typeof fetch` (`src/downloads/downloader.ts:65`). The downloader uses only `fetch(url, { method: 'HEAD' | GET, headers, signal })`, `res.status`, `res.ok`, `res.headers.get('content-length' | 'content-range')`, `res.body` (ReadableStream), `res.text()`, and relies on default redirect following.

## Code that worked

### Bun (`mech-bun-fetch.mjs`) — Bun-only, fails the runtime-agnostic gate as-is

```js
const init = {}
if (cfg.proxy && !shouldBypass(url, cfg.proxy.no_proxy)) init.proxy = proxyUrlWithAuth(cfg.proxy) // http://user:pass@host:port, https:// also fine
const tls = {}
if (cfg.ignore_ssl) tls.rejectUnauthorized = false
if (cfg.ca) tls.ca = cfg.ca; if (cfg.cert) tls.cert = cfg.cert; if (cfg.key) tls.key = cfg.key
if (Object.keys(tls).length) init.tls = tls
return (u, i = {}) => fetch(u, { ...i, ...init })
```

### Node, zero deps, undocumented (`mech-global-dispatcher.mjs`)

```js
if (!globalThis[Symbol.for('undici.globalDispatcher.1')]) await fetch('http://127.0.0.1:1/').catch(() => {}) // primes it
const Agent = globalThis[Symbol.for('undici.globalDispatcher.1')].constructor
const agent = new Agent({ connect: useProxy
  ? (opts, cb) => tunnel(cfg.proxy, opts.hostname, Number(opts.port) || 443, cfg)
      .then((s) => (opts.protocol === 'https:' ? upgradeTls(s, opts.servername ?? opts.hostname, cfg) : s))
      .then((s) => cb(null, s), cb)
  : { ca, cert, key, rejectUnauthorized } })
return (u, i = {}) => fetch(u, { ...i, dispatcher: agent })
```

### Node with an explicit `undici` dependency (`mech-undici.mjs`)

```js
import { ProxyAgent, Agent, fetch as ufetch } from 'undici'
const dispatcher = !useProxy ? new Agent({ connect: { ca, cert, key, rejectUnauthorized } })
  : new ProxyAgent({ uri: 'http://user:pass@proxy:8080' /* or socks5://… */, requestTls: {...}, proxyTls: {...} })
return (u, i = {}) => ufetch(u, { ...i, dispatcher }) // NOT globalThis.fetch
```

### Both runtimes, zero deps — the recommended one (`tunnel.mjs` + `mech-raw-socket.mjs`, ~280 lines)

Primitives (all `node:net` / `node:tls`, no `node:http`):

```js
// CONNECT: write the request line yourself; Bun's http.request rejects method CONNECT with an authority path.
sock.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ''}\r\n`)
// … read until "\r\n\r\n", require "HTTP/1.x 200", unshift any trailing bytes, resolve(sock)

// SOCKS5 (RFC 1928 + 1929): [5, nmethods, 0(,2)] → [5, method]; if 2: [1, ulen, user, plen, pass] → [1, 0];
// [5, 1, 0, 3, len, host, port_hi, port_lo] → [5, 0, 0, atyp, addr, port]; resolve(sock)

// TLS policy, identical for target and https-proxy hops:
tls.connect({ socket, servername, rejectUnauthorized: !cfg.ignore_ssl, ca: cfg.ca, cert: cfg.cert, key: cfg.key })
```

Client (`makeFetch(cfg)` → `(url, { method, headers, signal, redirect }) => Promise<Response>`): plain `http://` via
HTTP proxy = connect to proxy, absolute-URI request line + `Proxy-Authorization` (reqwest/curl semantics);
everything else = `tunnel()` (or direct `net.connect` when `shouldBypassProxy`) → optional TLS upgrade → HTTP/1.1
request with `Connection: close` → parse status/headers → body as a `ReadableStream` with backpressure
(`Content-Length`, chunked, or until close) → `new Response(body, { status, statusText, headers })`. Abort =
`socket.destroy(new DOMException('…', 'AbortError'))`. Redirects: fetch-spec loop (301/302/303/307/308, max 10,
303→GET, cross-origin drops `Authorization`), each hop re-tunnels and re-evaluates `no_proxy` for the hop host.

## Minimal abstraction for the core

The seam exists; only the implementation module is missing. Proposed shape (I/O module, tested with fixture servers
ported from `servers.mjs`; policy stays in `protocol.ts`):

```ts
// src/downloads/proxy-fetch.ts  (I/O: node:net, node:tls)
export interface TransportPolicy extends ProxyConfig { ca?: string; cert?: string; key?: string } // ca/cert/key: future, not in the app today
export function createPolicyFetch(policy: TransportPolicy, deps?: { connect?: typeof net.connect; tlsConnect?: typeof tls.connect }): typeof fetch

// src/downloads/downloader.ts — default for DownloaderDeps.fetchFor
fetchFor: (item, base) => (item.proxy ? createPolicyFetch(item.proxy) : base)
```

Rules: `validateProxyConfig` before use (already done in `run()`); `shouldBypassProxy` decides *per request URL*
inside the fetch (so redirect hops are re-evaluated); items without a policy never leave global `fetch` (HTTP/2,
pooling, zero behaviour change). CIDR in `no_proxy` would be a pure addition to `shouldBypassProxy` if ever wanted;
the app does not have it. `socks4` validates today in both Rust and TS but is not implemented anywhere in the spike —
either implement SOCKS4 (~30 lines) or reject it with a clear error; do not accept silently.

## What is impossible without a dependency

- **Nothing on Node** — three zero-dep mechanisms pass all 19 cases (raw-socket; builtin-agent; the undocumented dispatcher hack).
- **On Bun with `fetch` alone: SOCKS5/4** (`UnsupportedProxyProtocol`). With raw sockets: nothing.
- **With a dependency (`undici`)**: *still* nothing on Bun — the dependency is unusable there. So `undici` cannot be
  the cross-runtime answer; it could at most replace the raw client on Node, while Bun would still need either the
  raw client (for SOCKS) or `Bun.fetch` options (which the lint gate forbids).

## Recommendation

**Implement the raw-socket policy fetch in the core (zero dependencies), used only for items with a proxy/TLS
policy.** No ADR for a dependency is needed; an ADR should still record this decision (why not undici, why not
`Agent.createConnection`, why HTTP/1.1-only for proxied downloads).

Cost:
- ~280 lines of TypeScript (`tunnel` ~140 incl. SOCKS5 client, HTTP/1.1 client ~140) + ~230 lines of test fixtures
  (HTTP/CONNECT/HTTPS/SOCKS5 proxies, origins, mTLS, stats) — the spike files port almost 1:1.
- Tests must assert proxy *events* (the proxy saw the CONNECT/SOCKS handshake), never only "download succeeded";
  plus the three negative TLS cases, Range/206 through the tunnel, abort mid-stream, redirect with hop bypass, HEAD.
  Run them under Node **and** under the compiled Bun binary (`test:runtime-compat`), because Bun is where the silent
  bypass shows up.
- Functional limits accepted for proxied items only: HTTP/1.1, one connection per request (`Connection: close`),
  no content-encoding (fine: model files are already compressed; requests send no `Accept-Encoding`), SOCKS4 to be
  decided.

Rejected:
- `undici` as an explicit dependency: unusable on Bun (stub + fetch crash), requires `undici.fetch` on Node, and would
  pin the core to a second fetch implementation — cost with no cross-runtime gain.
- Bun `fetch({ proxy, tls })`: cleanest on Bun, but Bun-only, no SOCKS, and violates rule 6 (`types: ["node"]`).
- `Agent.createConnection` overrides / agent libraries: correct on Node, silently insecure on Bun.
- Global dispatcher hack: works on Node 22–25 but unexported API; would still need a Bun path.
- Env vars / `--use-env-proxy`: process-global, semantics differ from the app, no per-item and no client cert.

Risks / untested: real corporate proxies (NTLM/Kerberos are out of scope for the app too), IPv6 literal targets
through SOCKS (ATYP 4 reply parsing implemented, not exercised), proxies that answer CONNECT with `Proxy-Connection`
quirks, Windows (spike ran on macOS only; nothing platform-specific in the code, but `src/runtime/`-style Windows CI
should include the fixture servers). `socket.unshift` for bytes trailing the CONNECT response is exercised only with
empty trailing data.

## Files

- `servers.mjs` fixtures; `certs/` openssl material; `common.mjs` (policy helpers incl. CIDR); `tunnel.mjs` (CONNECT,
  SOCKS5, TLS upgrade); `mech-*.mjs` one per mechanism; `probe-lib.mjs`/`probe.mjs` case runner;
  `stream-probe.mjs`, `redirect-probe.mjs`, `bun-caps.mjs`; `compiled-entry.mjs` + `probe-bin` (Bun compiled);
  `run-all.sh`; results in `results.jsonl`, `stream-results.jsonl`, `redirect-results.jsonl`, `matrix.md`.
