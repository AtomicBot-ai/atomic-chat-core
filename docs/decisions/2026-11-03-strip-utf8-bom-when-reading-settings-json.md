---
date: 2026-11-03
title: "Strip a leading UTF-8 BOM when reading settings.json"
---

# 2026-11-03 — Strip a leading UTF-8 BOM when reading settings.json

- **Context:** `SettingsStore.open` passed the UTF-8 string returned by `fs.readFile` directly to `JSON.parse`. When a user or tool on Windows edited and saved `<data>\atomic-core\settings.json` with a leading UTF-8 byte-order mark (`U+FEFF`, default in Windows Notepad and PowerShell 5.1 `-Encoding UTF8`), `JSON.parse` rejected the leading character and core startup failed with `IO_ERROR`.
- **Decision:** strip a single leading `U+FEFF` character (`text.replace(/^\uFEFF/, '')`) before calling `JSON.parse` in `SettingsStore.open`, matching the BOM handling already used by `parseWindowsProbe` and `parseCachedTurboquantCatalog`.
- **Consequences:** hand-edited `settings.json` files saved with a UTF-8 BOM open cleanly without rewriting on read, and subsequent writes continue to emit standard UTF-8 without a BOM. Truncated or malformed JSON files still fail with `IO_ERROR` rather than being overwritten.
- **Owner:** `team`.
- **Links:** `src/settings/store.ts`, `src/settings/store.test.ts`, Sentry issue `ATOMIC-CHAT-CORE-2G`.
