import type { ReleaseAssetInfo } from './sdcpp-surface.mjs'
import type { AudiocppContract } from './audiocpp-surface.mjs'
import type { FetchReleaseFixturesInput, SdcppManifestDoc } from './sdcpp-fixtures.mjs'

export declare function audiocppHostArchive<A extends ReleaseAssetInfo>(
  contract: AudiocppContract,
  tag: string,
  assets: readonly A[],
  platform: string
): { backend: string; asset: A }
export declare function audiocppInstallManifest(input: {
  contract: AudiocppContract
  tag: string
  repo: string
  assets: readonly ReleaseAssetInfo[]
  updatedAt?: string
}): SdcppManifestDoc
export declare function fetchAudiocppFixtures(
  input: Omit<FetchReleaseFixturesInput, 'contract'> & { contract: AudiocppContract }
): Promise<void>
