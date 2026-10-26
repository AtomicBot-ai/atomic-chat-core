---
date: 2026-10-26
title: "An app core does not retire while it works, nor for time it was not running"
---

# 2026-10-26 — An app core does not retire while it works, nor for time it was not running

- **Context:** The app owner retires itself once its app's client registration expires (ADR
  2026-09-17-isolate-app-and-cli-owners): every 5 s it counted clients, and with none left after one
  had registered it called `shutdown()`. On an 8 GB MacBook Air (app 2.2.25, core 0.19.0, QA run
  2026-10-23) Z-Image Turbo Q3_K_M needed ~6.5 GB; the machine swapped, one app heartbeat timed out at
  14:41:00, the app dropped that registration and spent 51 s probing `/health`, the 45 s lease
  expired, and at 14:41:51 the core retired itself with step 1/8 of the image just done (`core.log`
  shows `core stopped` and nothing else; the app never posted `/shutdown`). The app launched a new core
  and the page said "The job disappeared". Two faults: an expired lease is read as "the app is gone"
  even when the core itself was not running to hear the heartbeats waiting in its socket, and the
  retirement throws away whatever is running. A third, smaller one: the timer did not close admission,
  so the app's re-registration at 14:41:51 succeeded on a core that was already stopping.
- **Decision:** The lease check is a pure decision (`src/core/app-lease.ts`). Each check gives every
  lease back the time the process was not running — the lateness of the check beyond its 5 s
  (`stalledMs`, `ClientRegistry.extendLeases`). With no client left, a core that holds work a
  retirement would throw away — an engine reporting `busy` (an image or video job) or a non-auxiliary
  model `loading` (`workInProgress`, over the same `GpuOccupancy` the residency rule reads) — stays up
  and logs once what it waits for; it retires at the first check after the work is over. Retiring
  closes admission in the same step (`acceptShutdown`), so a racing registration is refused with
  `CORE_NOT_RUNNING` instead of attaching to a stopping core.
- **Consequences:** A crashed app's core lives until its job ends (a long clip: hours) before it
  unloads; the next app launch still retires it at once through `/shutdown` (no other client). A chat
  model answering a request is not "work" — nothing tells it from an idle one without a proxy — so an
  idle-looking core still retires on lease expiry; the stall credit covers the case where it only
  looked expired because it had stopped. The app side of the same incident (a slow core is not
  dropped, the job survives a re-attach) is the app ADR
  2026-10-26-keep-a-slow-core-that-is-still-alive-attached.
- **Owner:** team
- **Links:** `src/core/app-lease.ts`, `src/core/create.ts` (app lease timer), `src/server/clients.ts`,
  `src/core/create.test.ts` ("keeps an app owner whose app went quiet…", "does not count time…"),
  QA finding NEW-06 / MEDIA-01 / REC-02.
