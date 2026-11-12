import type { ReleaseAssetInfo } from './sdcpp-surface.mjs'
import type { FetchReleaseFixturesInput } from './sdcpp-fixtures.mjs'
import type { MlxContract } from './mlx-surface.mjs'

/** conf's MLX manifest, as mirror-mlx.yml writes it (without `upstream_tag`, which the fetch does not know). */
export interface MlxManifestDoc {
  upstream_repo: string
  tag_name: string
  published_at?: string
  assets: Array<{ backend: string; name: string; sha256?: string; size?: number }>
}

export declare function mlxHostArchive<A extends ReleaseAssetInfo>(
  contract: MlxContract,
  tag: string,
  assets: readonly A[],
  platform: string
): { backend: string; asset: A }
export declare function mlxInstallManifest(input: {
  contract: MlxContract
  tag: string
  repo: string
  assets: readonly ReleaseAssetInfo[]
  updatedAt?: string
}): MlxManifestDoc
export declare function fetchMlxFixtures(
  input: Omit<FetchReleaseFixturesInput, 'contract'> & { contract: MlxContract }
): Promise<void>
