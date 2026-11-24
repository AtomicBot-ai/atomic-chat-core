---
date: 2026-11-23
title: "Resume a streamed chat completion by cursor instead of losing it"
---

# 2026-11-23 — Resume a streamed chat completion by cursor instead of losing it

- **Context:** Phones reach the public OpenAI-compatible API through the Cloudflare quick tunnel or the
  LAN. When the phone's network changes mid-answer (Wi-Fi ↔ LTE) or the app goes to the background, the
  stream breaks. The core then stops the generation: `clientGone` (`exchange.ts`) aborts the upstream
  request, and `pipeBody` destroys its body. The answer is lost, and the user has to send the request
  again and wait for the whole answer. Unsloth Studio solves this with server-side runs that the client
  reads by cursor. We measured that the quick tunnel streams a POST answer live but holds a streamed
  GET answer back until it ends, so every streaming route has to be POST. Plain OpenAI clients must
  keep working unchanged.

- **Decision:** A streamed chat completion can opt in to becoming a *run*. The core keeps the run's
  events in memory and lets the generation finish when the client is gone. A client that comes back
  reads the events it missed by sequence number.
  - **Opt-in.** `POST {prefix}/chat/completions` with `"stream": true` and the request header
    `X-Atomic-Resumable: 1` (exactly `1`). Without the header nothing changes, including the abort on
    disconnect. A request without `stream: true`, another value of the header, and any other route
    ignore the header.
  - **The stream.** It has the same headers and events as before, plus the response header
    `X-Atomic-Run-Id: <id>` (24 random bytes as base64url: 32 characters, 192 bits). Every event gets
    an `id: <seq>` line in front, with seq 1, 2, 3… and the final `data: [DONE]` included. The headers
    are flushed at once, so the client has the run id before the first token arrives. The opt-in
    header is meant for this core only and is not forwarded upstream. An upstream that is another
    core would otherwise keep a detached run of its own that nobody can cancel. Any
    `X-Atomic-Run-Id` the upstream sends is dropped from a run's answer.
  - **Resume.** `POST {prefix}/atomic/runs/{id}/events?after=<seq>`. Without `after`, the
    `Last-Event-ID` header is used, and without either the cursor is 0. When both are sent, the query
    wins. The answer is `200 text/event-stream` with `X-Atomic-Run-Id`: first the buffered events with
    seq > after, then the live ones, and the stream closes when the run ends. Any number of followers
    can read the same run at once. The request body is read and ignored.
  - **Cancel.** `POST {prefix}/atomic/runs/{id}/cancel` aborts the upstream request, ends the run and
    answers `204` without a body. Cancelling a run that has already ended is also a `204`. Every
    follower sees its stream end without `[DONE]`. Until the run expires, its buffered events can
    still be read.
  - **Errors.** They use the OpenAI envelope `{error: {message, type, code[, param]}}` as
    `application/json`, with the codes in `src/contracts/runs.ts`:
    - `404 run_not_found` for an unknown id, an expired run, a run another credential started, and a
      listener that keeps no runs. All four get the same body, so a client cannot learn from it
      whether a run exists.
    - `410 run_events_gone` when an event after the cursor has been dropped from the buffer. The
      client then sends its original request again.
    - `400 invalid_value` (`param: after`) when the cursor is not a non-negative integer (at most 15
      digits).
    - Any method other than POST (a CORS preflight aside) gets `405` with `Allow: POST`, so a GET
      is never answered as a stream.
  - **When a request becomes a run.** It becomes one when the engine answers 2xx with
    `text/event-stream`. Before that, the client has no run id it could resume with, so a client that
    leaves while the prompt is still being processed stops the request as before. Its retry reuses
    the engine's prompt cache. An answer that is not an event stream stays a plain answer. Error
    answers, the context-grow replay (`growAndRetry`) and the `/messages` fallback keep their current
    paths and are never resumable.
  - **Generation goes on after a disconnect.** A pump of the run's own reads the engine
    (`runs.ts`), and the client is only the run's first follower. The pump stops in only three
    cases: the engine ends the stream, the existing 10-minute idle timeout (`STREAM_IDLE_TIMEOUT_MS`)
    expires, or the run is cancelled. Cancelling happens on the cancel route, through the max age,
    and when the listener closes. Generation length is bounded by the request's own `max_tokens`
    and the engine's limits, as for any request.
  - **Bounds** (constants in `run-registry.ts`; tests override them through the registry's
    options):
    - **4 MiB of events per run.** A llama.cpp chat chunk is about 250 bytes, so this is about the
      last 16k tokens. When the buffer is full, the oldest events are dropped first. A client that
      dropped mid-answer only needs what came after its cursor, which is always the newest part.
      The newest event is always kept, even when it alone is larger than the cap.
    - **16 runs per listener**, running or finished, so all runs together hold at most 64 MiB. A
      local engine serves only a few requests in parallel. When all 16 slots are taken, the oldest
      finished run is dropped to make room. When every slot still holds a running run, the new
      request streams as a plain one without `X-Atomic-Run-Id` and stops with its client, instead
      of failing.
    - **TTL of 10 minutes after the run ends.** That is long enough for a phone to come back from
      the background.
    - **Max age of 60 minutes after the run starts, while no client follows it.** A run nobody has
      read for that long is cancelled and dropped. A run that a client follows is left alone,
      exactly like a plain stream. The check applies again once that client is gone.
    - The registry sweeps every 30 seconds while it holds runs, and also on every create and
      lookup. On a monotonic clock (`performance.now`).
  - **Ownership.** A run stores the sha256 of the configured key that started it. That is the
    listener's `api_key`, a per-device client key (`PUT /atomic/v1/server/client-keys`) or a key of
    the host's keyring, presented as `Authorization: Bearer` or as `x-api-key` (`gates.presentedKey`).
    Only a request that presents the same key can read or cancel the run, and the hashes are
    compared in constant time. A device key and the server key are different credentials. On a
    keyless listener, anyone who passes the Host gate and knows the run id can read and cancel the
    run: the unguessable id is the only guard there. Do not hand out run ids on a keyless listener
    that a tunnel exposes.
  - **Placement.** Both routes live on the public listener under the listener's prefix, after
    exactly the same gates as every inference route: prefix removal, the Host check (including the
    dynamic tunnel and socket hosts), the key check, and CORS headers on every answer.
  - **Each listener has its own runs.** `PublicServer.start` creates the registry unless one is
    injected (`PublicServerDeps.runs`), and `close()` cancels every run. So stopping or restarting
    the listener stops its runs, as it always stopped its streams.
  - **OpenAPI document.** The served `/openapi.json` adds both routes (tag `Runs`, schema
    `RunErrorDto`) and the `X-Atomic-Resumable` header parameter on `/chat/completions`
    (`runs-openapi.ts`). These are added to the app's embedded document when it is served. Anything
    the app's document already describes stays as it is, and so does `info.title`, which the tunnel
    probe reads. The proxy-http contract replay records this as a known divergence.

- **Consequences:**
  - **SSE compatibility.**
    - The `id:` lines are standard SSE fields. The OpenAI Node SDK ignores them, and so do
      `eventsource-parser` (the AI SDK) and `EventSource`. A test streams a resumable run through
      `@ai-sdk/openai-compatible`.
    - The OpenAI Python SDK keeps the last `id` across events. After an id, every blank line
      dispatches an event, even one with empty data, and the SDK then fails to parse that empty data
      as JSON. So the framer (`SseEventFramer` in `sse.ts`) never ends a block without `data` with a
      blank line:
      - A keep-alive comment passes through as a comment line without its blank line.
      - Other fields in a data-less block are dropped. One example is llama.cpp's old `error:` line,
        which no client read.
      - Stray blank lines are dropped.
      - An `id:` sent by the upstream is dropped, so it cannot override the run's numbering.
      - An unterminated last event is closed when the stream ends.

      A test runs a port of the Python decoder over the stream.
    - Telemetry still reads every upstream line with `SseLineReader` before framing. The usage-only
      trailer that the inspector asked the engine for is dropped *before* numbering, so it never
      takes a seq and the ids have no gaps.
    - Clients that send no header get exactly the bytes they got before.
  - **Not resumable in this change.** These requests ignore the header and stream as before:
    - ChatGPT subscription models (`subscription.ts`): they are answered before the generic
      forwarder.
    - `/completions`, `/messages` and `/responses`. `/responses` is the obvious follow-up: its
      translated stream would need the same pump and framer, after the translation.

    Remote and self-hosted chat providers that take the generic path are resumable through the same
    pump.
  - **Browsers.** `X-Atomic-Resumable` and `Last-Event-ID` are not in the preflight allow-list. The
    run id header is not in `Access-Control-Expose-Headers` either. A browser page therefore cannot
    opt in. The target is the native phone client, and widening the recorded CORS contract is left
    for when a browser client needs it.
  - **The request log.** The request that started a run is still reported when its first response
    closes, as `aborted` if the client dropped. Tokens generated after the drop are not in that
    record. Resume and cancel requests are bookkeeping and are not reported.
  - **Bun.** The resume and cancel routes read the request body before they answer, because Bun
    loses an answer written before the body is read (ADR
    2026-09-22-detect-a-client-that-hangs-up-before-the-answer-under-bun). A test on the compiled
    binary checks the whole flow under Bun with a fake llama-server: a client drops mid-answer, the
    generation finishes, and a resume by `after` and by `Last-Event-ID` returns the rest.
  - **Memory.** At most 64 MiB of events in the worst case, held only by runs that clients opted
    into.

- **Owner:** `team`

- **Links:** `src/server/public/runs.ts` (opt-in, pump, followers, routes),
  `src/server/public/run-registry.ts` (bounds, ownership, expiry), `src/server/public/sse.ts`
  (`SseEventFramer`), `src/server/public/runs-openapi.ts`, `src/server/public/forward.ts`
  (`serveForward`), `src/server/public/gates.ts` (`presentedKey`), `src/contracts/runs.ts`, tests
  `src/server/public/{runs,run-registry,runs-openapi,sse,gates}.test.ts`,
  `test/e2e/public-server.test.ts`, `test/contract/proxy-http.test.ts`; ADRs
  `2026-11-12-accept-app-client-keys-next-to-the-server-key.md`,
  `2026-09-17-the-core-owns-the-cloudflare-quick-tunnel.md`.
