# llama.cpp fixtures

What real ggml-org `llama-server` builds print, for the engine contract checks
(`test/contract/llamacpp-help.test.ts`) and the surface diff.

- `engine-contract.json` — generated, never edited by hand: every flag and closed value core emits for
  upstream llama.cpp and from which build to which (`test/helpers/llamacpp-engine-contract.ts`).
  Regenerate with `npx vitest run --project contract -u test/contract/llamacpp-engine-contract.test.ts`
  and review the diff: it is the list of things a new llama.cpp release must keep accepting.
  Besides the flags it holds `strings` (log lines and bodies core matches) and `routes` (what core
  calls on a session, and the fields it reads), curated in `test/helpers/llamacpp-engine-strings.ts`:
  each names the core file that holds it, how much losing it costs (`severity_if_lost`) and what the
  live probe (`test/live/llamacpp-contract.test.ts`) sees on a stock build (`live_expectation`).
- `observed/<tag>-<backend>.json` — what a real build said to the live contract probe, without
  timestamps, paths or ports: its startup and ready lines, the 401, the 501s of a route it was not
  started for, the context-overflow envelope, `--version`. `test/contract/fake-llama-server-vs-real.test.ts`
  holds the fake llama-server to each file. A new one is the `golden` section of a probe's
  `observed.json` (CI's `llamacpp-observed-<os>` artifact):
  `jq '{schema: "atomic-engine-observed-golden", schema_version: 1, engine, tag, build, host, golden}'`.
- `help/<tag>.txt` — `llama-server -h`; `version/<tag>.txt` — `llama-server --version`. Each file is
  stdout, a newline, stderr: the shape `runHelp` (`src/runtime/llamacpp/probe.ts`) reads.

Captured on macOS arm64 (Apple M4 Pro) on 2026-10-14 with
`node scripts/fetch-live-fixtures.mjs --out <dir> --tag <tag> --skip-model --capture`, from these
assets (sha256 checked against the release digest):

| tag | sha256 of `llama-<tag>-bin-macos-arm64.tar.gz` | why it is here |
|---|---|---|
| b10344 | `24bf4348ddc6d1d9b465105ed8ae371e326c576623ac612fbff73532181c8f13` | `--version` before the `(build N, commit X)` format |
| b10400 | `bb0172e886c7b6ece52edf04db03bc692ffc28e096728351c0343e4c75bb5374` | first capture with `0.1.0-dev (build N, …)` |
| b10874 | `8a72284e8b8e7fdf374df000ed6490c26889f24747e5f966e84b93c15af435c9` | last build with `--mmap`/`--mlock`, already marked DEPRECATED |
| b10875 | `77accce8b19d1c7e00db4e5e3e988c2d78f0662914ee9251ddd8bbe2b3a9ca84` | `--mmap`/`--mlock`/`--direct-io` removed (ggml-org/llama.cpp#28334) |
| b11463 | `bef66fc5f7993c2ce814c6b619df6eb8ca3a5213cf3eb828918674c22324b252` | the approved release at the time |
| b11617 | `051bb0b55b3e5e72081aa819131ba30c74d910acc915b28bab298757472e39d9` | newest at capture time |
