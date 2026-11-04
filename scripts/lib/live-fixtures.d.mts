export declare const DEFAULT_RELEASE_REPO: string

export interface ReleaseAsset {
  name: string
  size?: number
  digest?: string | null
  browser_download_url?: string
}

export interface Release {
  tag_name: string
  draft?: boolean
  prerelease?: boolean
  assets?: ReleaseAsset[]
}

export declare function assetPatternFor(
  platform: string,
  arch: string,
  exactName?: string,
  tag?: string
): RegExp

export declare function pickRelease<R extends Release>(
  releases: readonly R[],
  pattern: RegExp
): { release: R; asset: NonNullable<R['assets']>[number] } | undefined

export declare function digestMatches(digest: unknown, sha256: string): boolean | undefined

/** What a fetch put on disk for the live run (`live.json`). */
export interface LiveValues {
  engine_dir?: string
  tag?: string
  manifest?: string
  models?: Record<string, string>
}

export declare function expandLiveEnv(
  template: Readonly<Record<string, string>>,
  values: LiveValues
): Record<string, string>

export declare function liveModelsKey(models: ReadonlyArray<{ sha256: string }> | undefined): string
