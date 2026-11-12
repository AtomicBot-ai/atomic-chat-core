// What MLX's live tests run on (`node scripts/fetch-live-fixtures.mjs --engine mlx`): the release's
// one archive, unpacked alone into its own folder (the folder the runtime test passes the core as its
// resources dir, ATOMIC_LIVE_MLX_RESOURCES), the model folder of the config's `live_models`
// (SmolLM2-135M-Instruct 8-bit) checked file by file against its sha256, a manifest of the release
// for the install test (ATOMIC_MLX_MANIFEST_URL), and what `mlx-server --help` prints (help.txt).
// sd.cpp's fetch (sdcpp-fixtures.mjs) with MLX's release spec; the manifest is conf's MLX manifest,
// not a ggml one.
import { MLX_RELEASE, mlxBackendArchives } from './mlx-surface.mjs'
import { fetchReleaseFixtures, releaseHostArchive } from './sdcpp-fixtures.mjs'

/** `sha256:<hex>` → `<hex>`; `undefined` for anything else. */
const digestHex = (digest) => (/^sha256:[0-9a-f]{64}$/.test(digest ?? '') ? digest.slice(7) : undefined)

/** The archive of `platform` in a release's `assets`; throws when there is none, or two (`releaseHostArchive`). */
export function mlxHostArchive(contract, tag, assets, platform) {
  return releaseHostArchive(contract, tag, assets, platform, MLX_RELEASE)
}

/**
 * conf's MLX manifest for `repo`@`tag`, as conf's mirror-mlx.yml writes it: the archive each contract
 * backend takes, pinned by its size and the sha256 of the release's digest, downloaded from `repo`'s
 * release of `tag` (`upstream_repo`), ordered by the release's `published_at`. A fork release named
 * by its upstream tag (`vX.Y.Z`) gets a manifest no core reads: cores install only
 * `mlxvlm-macos-arm64-<hex>`, the name conf's mirror gives the build.
 */
export function mlxInstallManifest({ contract, tag, repo, assets, updatedAt }) {
  const archives = mlxBackendArchives(
    contract,
    tag,
    assets.map((a) => a.name)
  )
  const entries = []
  for (const b of contract.assets?.core_backends ?? []) {
    const names = archives[b.backend]
    if (names.length !== 1) continue
    const asset = assets.find((a) => a.name === names[0])
    entries.push({
      backend: b.backend,
      name: asset.name,
      ...(digestHex(asset.digest) ? { sha256: digestHex(asset.digest) } : {}),
      ...(asset.size ? { size: asset.size } : {}),
    })
  }
  return {
    upstream_repo: repo,
    tag_name: tag,
    ...(updatedAt ? { published_at: updatedAt } : {}),
    assets: entries,
  }
}

/** MLX's release spec with what its fetch needs: `mlx-server`, its `--help`, and no `--version`. */
const MLX_FIXTURES = {
  ...MLX_RELEASE,
  server: 'mlx-server',
  executables: ['mlx-server'],
  engineEnv: 'ATOMIC_LIVE_MLX_RESOURCES',
  captures: [{ file: 'help.txt', argv: ['--help'] }],
  versionArgv: null,
  // The first run of a freshly unpacked 210 MB onefile is scanned by Gatekeeper (MLX_PROBE_TIMEOUT_MS).
  captureTimeoutMs: 120_000,
  installManifest: mlxInstallManifest,
}

/** Everything one live cell of MLX needs, under `out` (`fetchReleaseFixtures`). */
export function fetchMlxFixtures(input) {
  return fetchReleaseFixtures(input, MLX_FIXTURES)
}
