---
date: 2026-11-12
title: "Refuse to replace a backend pack a session runs from"
---

# 2026-11-12 — Refuse to replace a backend pack a session runs from

- **Context:** An install ended in `disk_file_locked` (EPERM) on Windows after the full retry ladder (ATOMIC-CHAT-CORE issue 7833107070). The final swap in `BackendService.install` (`src/backend/install/service.ts`) deletes the destination pack unconditionally before renaming staging into place. `remove()` refuses a pack something runs from with `BACKEND_IN_USE`, and `repairRocmRuntime()` asks to unload models before repairing — the install replace path was the only destructive step without that guard, so a running `llama-server` held the old files while they were already deleted.
- **Decision:** `install` refuses with the same `BACKEND_IN_USE` error before anything is downloaded: after the no-op early return for an installed pack, when `host.inUse()` reports the pack running. The retry ladder, the disk tags and the swap itself are unchanged; a repair (`force: true`) of an in-use pack is refused the same way.
- **Consequences:** Reinstalling a pack a model runs from now fails fast with an explicit instruction instead of downloading the full pack and failing on the swap (Windows) or replacing files under a live session (other platforms). The caller unloads the model and retries, as with `remove()`.
- **Owner:** team
- **Links:** ATOMIC-CHAT-CORE issue 7833107070, `src/backend/install/service.ts`, `src/backend/install/service-in-use.test.ts`
