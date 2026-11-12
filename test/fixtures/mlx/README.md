# MLX fixtures

What the engine candidate check (`engine=mlx`, `scripts/lib/mlx-surface.mjs`) holds an `mlx-server`
build to, and the releases and conf manifests it is tested on.

## `engine-contract.json`

Written by hand; `test/contract/mlx-engine-contract.test.ts` holds it to the help screens below,
`src/runtime/mlx` and `src/engine-builds`. The flags `buildMlxServerArgs` passes and the choices of
`--draft-kind` and `--kv-quant-scheme`, the install probe (`--help`: exit 0 and `usage: mlx-server`),
what the archive unpacks to (`mlx-server` alone), the env the runtime sets, the archive by backend id,
and the upstream (Neywa-Labs/mlx-vlm) sources they live in, `mlx_vlm/server/` watched as a folder.

## `help/`

`mlx-server --help` (exit 0), stdout, a newline, stderr, as `runInvocations` captures it, on an Apple
M4 Pro, 2026-11-12:

| File | Build |
| --- | --- |
| `mlxvlm-macos-arm64-07ba5a1.txt` | the fork's release `mlxvlm-macos-arm64-07ba5a1`, conf's live pin (based on upstream v0.6.15); `mlxvlm-macos-arm64-89acca5` prints the same |
| `v0.7.12.txt` | the fork's release `v0.7.12` (Release (Atomic) of upstream v0.7.12) |

## `conf/`

| File | What |
| --- | --- |
| `mlx-manifest.json` | conf's live manifest, verbatim (conf `main` at `f57927c`): the fork's `mlxvlm-macos-arm64-07ba5a1`, no `upstream_tag` |
| `mlx-manifest.staging.json` | conf's mirror of the fork's `v0.7.12` as `mirror-mlx.yml` writes it (hand-made: the release date; `1f48deb` is the commit the fork's build ran at), the same bytes as the fork's archive |

## `releases/`

GitHub releases as `{repo, tag, published_at, target_commitish, prerelease, assets: [{digest, name, size}]}`:

| File | What |
| --- | --- |
| `v0.7.12.json` | the fork's `AtomicBot-ai/mlx-vlm` `v0.7.12`, verbatim from the API (2026-11-12) |
| `mlxvlm-macos-arm64-07ba5a1.json` | the fork's `mlxvlm-macos-arm64-07ba5a1`, verbatim from the API (2026-11-12) |
| `mlxvlm-macos-arm64-1f48deb.json` | conf's mirror of `v0.7.12` (hand-made after `mirror-mlx.yml`: the archive and `requirements.lock.txt` copied byte for byte) |
