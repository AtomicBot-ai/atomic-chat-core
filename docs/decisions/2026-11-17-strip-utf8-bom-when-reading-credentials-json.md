---
date: 2026-11-17
title: "Strip a leading UTF-8 BOM when reading credentials.json"
---

# 2026-11-17 — Strip a leading UTF-8 BOM when reading credentials.json

- **Context:** `ApiKeyStore.open` passed the UTF-8 string returned by `fs.readFile` directly to `JSON.parse`. When a user or tool on Windows edited and saved `<data>\atomic-core\credentials.json` with a leading UTF-8 byte-order mark (`U+FEFF`, the default in Windows Notepad and PowerShell 5.1 `-Encoding UTF8`), `JSON.parse` rejected the leading character and `createAtomicCore` failed during startup with `IO_ERROR`, so the core — and the app with it — refused to start. `SettingsStore.open` already strips the same mark (`2026-11-03-strip-utf8-bom-when-reading-settings-json.md`); the credentials reader was missed.
- **Decision:** strip a single leading `U+FEFF` character (`text.replace(/^\uFEFF/, '')`) before calling `JSON.parse` in `ApiKeyStore.open`, exactly as `SettingsStore.open` does. Nothing is written: the file is only read, and the next `persist()` still writes standard UTF-8 without a BOM through `.tmp` + rename.
- **Consequences:** a `credentials.json` saved by a Windows editor or PowerShell opens cleanly and its keys stay usable. A file that is genuinely truncated or malformed JSON still fails with `IO_ERROR` instead of being silently replaced, so entered keys are never thrown away. A UTF-16 file written by Notepad's "Unicode" encoding is not covered and still fails loudly.
- **Owner:** `team`.
- **Links:** `src/credentials/api-keys.ts`, `src/credentials/api-keys-bom.test.ts`, `src/settings/store.ts`, `docs/decisions/2026-11-03-strip-utf8-bom-when-reading-settings-json.md`, Sentry issue `ATOMIC-CHAT-CORE-CN`.
