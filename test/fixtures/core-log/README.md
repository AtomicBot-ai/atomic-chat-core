# `core.log` fixture

`sample.log` pins the on-disk format of `<data>/atomic-core/logs/core.log` (docs/contracts.md, design
D9 of the `add-unified-logs` change). Direction here is the reverse of most sets under
`test/fixtures/app/`: **the core is the source of truth**, not the app. It is produced by
`test/contract/core-log.test.ts`, which writes it through the real `openLogFile`/`formatLogLine`
machinery (`src/host/log-file.ts`) with a fixed clock and compares the result to this file byte for
byte — the same relationship `test/fixtures/webm/README.md` describes for its own hand-produced,
non-app fixture.

Contents, in order:

- a single-line `core` entry (the app-core startup line shape, D6);
- a single-line `WARN` entry (matches the example in `specs/core-log/spec.md`);
- a multi-line `ERROR` entry: header on the first line, two continuation lines with no header of
  their own;
- two `engine:llamacpp/<model>` entries at `INFO`, one prefixed `[stderr] `, one `[stdout] `.

When the app copies this file into its own tests (`core::logs`, design D9), it names the core commit
it copied from, the way this repo's own imported fixtures pin a source commit.
