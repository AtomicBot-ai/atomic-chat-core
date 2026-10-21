import type { ReleaseAssetInfo, SdcppContract } from './sdcpp-surface.mjs'

export interface SdcppManifestDoc {
  updated_at?: string
  upstream_repo: string
  tag_name: string
  download_base: string
  assets: Array<{ backend: string; name: string; sha256?: string; size?: number; companion?: true }>
}

export interface LiveModel {
  id: string
  url: string
  sha256: string
  bytes?: number
}

export declare function sdcppHostArchive<A extends ReleaseAssetInfo>(
  contract: SdcppContract,
  tag: string,
  assets: readonly A[],
  platform: string
): { backend: string; asset: A }
export declare function sdcppInstallManifest(input: {
  contract: SdcppContract
  tag: string
  repo: string
  assets: readonly ReleaseAssetInfo[]
  updatedAt?: string
}): SdcppManifestDoc
export declare function liveModelPath(modelsDir: string, model: LiveModel): string
export declare function fetchSdcppFixtures(input: {
  out: string
  tag: string
  repo: string
  config: { live_models?: LiveModel[] }
  contract: SdcppContract
  modelsDir: string
  skipModel: boolean
  token?: string
  platform: string
}): Promise<void>
