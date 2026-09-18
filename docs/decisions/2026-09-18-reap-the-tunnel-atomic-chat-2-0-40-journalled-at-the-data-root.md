---
date: 2026-09-18
title: "Reap the tunnel Atomic Chat 2.0.40 journalled at the data root"
---

# 2026-09-18 — Reap the tunnel Atomic Chat 2.0.40 journalled at the data root

- **Context:** 2.0.40 is the one release whose Rust ran the Cloudflare quick tunnel. It journalled the child at `<data>/remote-access-tunnel.json` as `{pid, started_at_secs}` (`remote_access/journal.rs`) and reaped it at its next startup (`lib.rs`, `reap_orphan`). Linux ended the child with the app (`PR_SET_PDEATHSIG`); on macOS and Windows a crash or a Force Quit left `cloudflared` running with its public URL, and so did a Windows in-app update, whose exit skips the app's exit hook. The app on the core-migration line deleted that module, and the core reaped only its own `<data>/atomic-core/remote-access-tunnel.json`. After an upgrade nothing read the old file, so the orphan lived until reboot. The core's Host gate answers its requests with 403, but the process and the public name stay.
- **Decision:** At startup the core also reaps `<data>/remote-access-tunnel.json` (`DataLayout.legacyRemoteAccessTunnel`). This runs right after the core's own journal and before the endpoint is published, through the same `reapTunnelOrphan`. The file is removed before it is parsed, whatever it says. The process is killed only when it is alive, is not this process, started within 5 s of `started_at_secs` (the entry has no start identity) and is named `cloudflared*`. An entry without `started_at_secs` is spared. The core never writes that path.
- **Why a live 2.0.40 cannot be hit:** only the app owner's folder can hold the file. The CLI owner refuses the app's folder ([isolate app and CLI owners](2026-09-17-isolate-app-and-cli-owners.md)). The app's single-instance plugin keeps a 2.0.40 app from running next to the app that launched this core, so the entry always describes a previous run.
- **Consequences:** a tunnel orphaned by 2.0.40 ends at the first start of the core that replaced it, and the file goes with it. The path is adopted from the app, like `<data>/diffusion/` and `<data>/images`, but it is only read and removed, never written. The read can go once no supported upgrade starts from 2.0.40: it is one line in `create.ts` plus the layout entry.
- **Owner:** team.
- **Links:** `src/remote-access/journal.ts`, `src/core/create.ts`, `src/config/paths.ts`; app source `src-tauri/src/core/server/remote_access/journal.rs` and `src-tauri/src/lib.rs` at tag `v2.0.40`; [the core owns the Cloudflare quick tunnel](2026-09-17-the-core-owns-the-cloudflare-quick-tunnel.md).
