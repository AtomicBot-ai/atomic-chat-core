# Port the terminal patch to the current core

`atc` (repository `eye-cli`) embeds a private core build, `atomic-chat-core-0.11.2-terminal.3.tgz`
(`eye-cli/vendor/`, SHA-256 `86caad0f8c0b706e8318368b4edeb782adca9644d39e7ababe7632a2d50e3071`): v0.11.2
plus a patch from commit `58d64a8` on `feat/terminal-keyring`. That commit exists nowhere — not in this
repository, not on GitHub — so the patch survives only as compiled JavaScript inside the archive. None of
it is in 0.12 or 0.13, so `atc` cannot move to a current core until it is ported here.

## Status

Ported to `src/` on 2026-10-10 ([ADR](decisions/2026-10-10-the-terminal-patch-is-ported-and-what-it-changes-is-opt-in.md)).
Left: a core release, then `eye-cli`. Two differences from the archive matter there: `atc` must pass
`remoteGgufTimeoutMs: 20000` itself (the patch hard-coded 20 s for every caller, the app included),
and the 250 ms progress cadence now comes only with `downloadStreams` > 1. The archive also recovers
stalled ranges after 120 s of silence ("inactivity-based range recovery" in its `vendor/README.md`):
that is part of feature 2.

## What the patch adds

| # | Feature | Public surface | Used by `atc` for |
| --- | --- | --- | --- |
| 1 | **API keyring.** The public server accepts any key of a list sampled on every request; an empty list refuses all clients; `undefined` falls back to `server.api_key`. | `AtomicCoreOptions.publicApiKeys?: () => readonly string[] \| undefined`; `apiKeys` in `server/public/types` and the gate in `server/public/gates` | `client-keys.json`: several named keys, revoke without a restart. Every `/v1` client needs a key because of it. |
| 2 | **Parallel downloads.** A file with a known hash downloads over several byte-range streams. | `AtomicCoreOptions.downloadStreams?: number`; `DownloaderOptions.streams`; new `downloads/segmented` | Faster model downloads (`downloadStreams: 4`). |
| 3 | **Download snapshot.** Active transfers are part of the control snapshot (today `downloads: []`). | `Downloader.snapshot(): { taskId, transferred, total, percent }[]`; `downloads?: () => unknown[]` in `server/control/types`, served as `downloads` in `GET /snapshot` | Setup progress after a reconnect; not starting an engine install twice. |
| 4 | **Bounded remote GGUF inspection.** Reading a remote header gives up after a timeout and a byte cap, growing the range from 64 KiB. | `inspect` options `timeoutMs` (default 20 s) and `maxBytes` (default 64 MiB) in `models/compatibility/inspect` | Model checks that cannot hang on a slow or broken mirror. |

Changed files in the archive's `dist/` against a clean v0.11.2 build: `core/{atomic-core,create,public-server,types}`,
`downloads/{downloader,segmented}`, `models/compatibility/inspect`, `server/control/{router,types}`,
`server/public/{gates,index,types}` — about 110 changed lines plus `segmented.js` (134 lines).

## How to recover the diff

From this repository's root (a sibling checkout of `eye-cli` holds the archive):

```bash
T="$(mktemp -d)"; mkdir -p "$T/vend" "$T/v11"
tar -xzf ../eye-cli/vendor/atomic-chat-core-0.11.2-terminal.3.tgz -C "$T/vend"
git archive v0.11.2 | tar -x -C "$T/v11"
ln -s "$PWD/node_modules" "$T/v11/node_modules"
(cd "$T/v11" && npx tsc -p tsconfig.build.json)
diff -ru -x '*.map' -x bin "$T/v11/dist" "$T/vend/package/dist"
```

The `.d.ts` diff is the API, the `.js` diff the behaviour. Rewrite it as TypeScript against the current `src/`, not by copying the output.

## Done when

- The four features are in `src/` with tests: keyring precedence (`undefined` / `[]` / list) and revocation
  on the next request; segmented download with a checksum mismatch and a dropped stream; `snapshot()`
  during a transfer and in `GET /snapshot`; inspection hitting the timeout and the byte cap.
- `npm run verify` is green and a core release is published.
- In `eye-cli`: the dependency points at that release instead of `vendor/*.tgz`, `vendor/README.md` and
  `docs/release.md` say so, and its `npm run verify` is green — notably `test/contract/daemon.test.ts`
  ("never serves the public API without a key").

This is a core change across two repositories: plan it in `atomic-chat-spec` with `/feature` (tasks
`core:` then `cli:`).
