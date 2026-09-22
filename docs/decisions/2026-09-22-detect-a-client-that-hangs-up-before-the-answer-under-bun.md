---
date: 2026-09-22
title: "Two things Bun's node:http does not tell the server: a client that hangs up before the answer, and an answer written before the body is read"
---

# 2026-09-22 — Two things Bun's node:http does not tell the server: a client that hangs up before the answer, and an answer written before the body is read

- **Context:** The public and control servers are written to `node:http` and unit-tested under Node,
  as the 2026-09-15 decision has it; the compiled binary runs them under Bun (1.3.10). The binary-level
  e2e of stage 7p found two places where Bun's compatibility layer stays silent and the behaviour on
  the binary differed from the tests:
  1. `clientGone` stops work nobody is waiting for — the image job behind `POST
     /v1/images/generations`, the upstream request of a non-streamed chat completion, an Anthropic
     fallback or a context-grow retry — through an `AbortSignal` wired to the response's `close`,
     which Node emits when the client disconnects before the answer is complete. Bun emits nothing at
     all for a request whose response has not started: no `close` on the response or the socket,
     `socket.readyState` stays `open`. On the binary an image job ran to its end for a client that had
     hung up. The only trace Bun leaves is the `aborted` flag on the native handle it keeps on the
     response under a symbol described `handle` (the request drops it once its body is consumed).
  2. `readJsonBody` refuses a body over its cap (8 MiB, 64 MiB for a generation with inline sources)
     by throwing as soon as the count passes the limit; the router answers 400 `Request body is too
     large.` while the rest of the body is still arriving. Node delivers that answer. Bun delivers an
     empty 200 — the status and body written before the request was read are lost — and, past its own
     ceiling, resets the connection. On the binary an oversized generation request came back as a 200
     with no body.
- **Decision:** (1) `clientGone` keeps the `close` listener and, while the answer is pending, also
  polls every 500 ms whether the client is gone: the request socket's `destroyed` flag (Node) or the
  `aborted` flag of the response's handle looked up by its symbol's description (Bun), absent-safe.
  (2) `readJsonBody` reads and discards the rest of an oversized body, up to eight times the limit,
  before throwing; beyond that it drops the connection. Both are confined to their one function, and
  `test/runtime-compat/http-hangup.test.ts` runs under Node and `bun test` so the day Bun renames the
  handle, starts emitting the event or delivers an early answer, the work-arounds are seen to be
  obsolete.
- **Consequences:** A client that hangs up is noticed within half a second on both runtimes; an
  oversized body gets its 400 on both. One unreferenced `setInterval` per request waiting for its
  answer, cleared on `finish` or `close`; up to 8× the cap read and thrown away for a refusal (64 MiB
  for the general cap, 512 MiB for a generation), bounded time and no memory. The runtime-agnostic
  gate is untouched (no `Bun.*`); the Bun-specific knowledge is one symbol lookup with a test that
  says so. Bun's `close` on the streaming path (a write to a gone client) is unchanged and was already
  covered by the stream-cancel e2e. The public server's `readBody` has no cap and is not changed here.
- **Owner:** team.
- **Links:** `src/server/public/exchange.ts` (`clientGone`, `requestAborted`), `src/server/http.ts`
  (`readJsonBody`, `OVERSIZE_DRAIN_FACTOR`), `src/server/public/exchange.test.ts`,
  `src/server/http.test.ts`, `test/runtime-compat/http-hangup.test.ts`, `test/e2e/images-api.test.ts`,
  `test/e2e/diffusion.test.ts`; `2026-09-15-core-is-typescript-node-compatible-api-packaged-with-bun.md`.
