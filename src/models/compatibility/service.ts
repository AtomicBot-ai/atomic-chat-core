/**
 * The compatibility check as a service: rules (live or cached) + evidence (local header, remote
 * header, or nothing) + the installed PrismML build → a verdict, and the load gate built on it.
 *
 * The gate never touches the network and never blocks on missing evidence: it refuses a load only
 * when the header (or a conf rule matched by sha256) says the file cannot run on the chosen engine.
 * A header that cannot be read is left to the engine to report, as before this check existed.
 */

import { AtomicCoreError } from '../../contracts/index.js'
import type {
  LocalProviderId,
  ModelCompatibilityResponse,
  PrismFamiliesResponse,
  PrismFamilyFile,
} from '../../contracts/index.js'
import { hfResolveUrl, inspectLocalGguf, inspectRemoteGguf } from './inspect.js'
import { gateDecision, resolveCompatibility } from './resolve.js'
import type { GgufEvidence, InstalledPrism } from './resolve.js'
import { findPrismModelRule } from './rules.js'
import type { RuleMatch } from './rules.js'
import type { PrismModelRulesService } from './rules-service.js'

/** The engines whose loads go through the gate: every llama.cpp provider. */
export const GATED_PROVIDERS: ReadonlySet<LocalProviderId> = new Set([
  'llamacpp',
  'llamacpp-upstream',
  'atomic-prism',
])

export interface ModelCompatibilityServiceDeps {
  rules: Pick<PrismModelRulesService, 'rules' | 'cachedRules'>
  /** The PrismML build a load would run on; `offline` for the load gate, which never fetches. */
  installedPrism: (options: { offline: boolean }) => Promise<InstalledPrism>
  fetch: typeof fetch
  hfToken?: () => string | undefined
  /** Replaced in tests. */
  inspectLocal?: (path: string) => Promise<GgufEvidence>
  inspectRemote?: (
    url: string,
    options: { fetch: typeof fetch; token?: string; timeoutMs?: number }
  ) => Promise<GgufEvidence>
  /** How long a remote header read may take in all (`AtomicCoreOptions.remoteGgufTimeoutMs`); none when unset. */
  remoteTimeoutMs?: number
  log?: (level: 'info' | 'warn', message: string) => void
}

export interface CompatibilityQuery {
  /** Absolute path of a GGUF already on disk. */
  modelPath?: string
  sha256?: string
  repo?: string
  file?: string
  revision?: string
  inspectRemote?: boolean
}

export class ModelCompatibilityService {
  constructor(private readonly deps: ModelCompatibilityServiceDeps) {}

  /** The verdict for one file, with the family's conf defaults when a rule matched. */
  async check(query: CompatibilityQuery): Promise<ModelCompatibilityResponse> {
    const rules = await this.deps.rules.rules()
    const rule = findPrismModelRule(rules, query)
    const evidence = rule ? undefined : await this.evidenceFor(query)
    const verdict = resolveCompatibility({
      rules,
      ...(rule ? { rule } : {}),
      ...(evidence ? { evidence } : {}),
      prism: await this.deps.installedPrism({ offline: false }),
    })
    const family = rule?.family
    const defaults =
      family && (family.sampling || family.default_ctx)
        ? {
            ...(family.sampling ? { sampling: family.sampling } : {}),
            ...(family.default_ctx ? { ctx_len: family.default_ctx } : {}),
          }
        : undefined
    return { ...verdict, ...(defaults ? { defaults } : {}) }
  }

  /** The conf rule for a file, as `check` would match it. */
  /** The Bonsai families the Hub lists, each with only the files it may offer. */
  async families(): Promise<PrismFamiliesResponse> {
    const rules = await this.deps.rules.rules()
    const offered = (treatment: string): treatment is PrismFamilyFile['treatment'] =>
      treatment === 'prism_required' || treatment === 'any'
    return {
      rules_version: rules.rules_version,
      families: rules.families.flatMap((family) => {
        const files: PrismFamilyFile[] = family.files.flatMap(({ treatment, ...file }) =>
          offered(treatment)
            ? [
                {
                  file: file.file,
                  size: file.size,
                  sha256: file.sha256,
                  treatment,
                  ...(file.packing ? { packing: file.packing } : {}),
                  ...(file.default ? { default: true } : {}),
                  ...(file.summary ? { summary: file.summary } : {}),
                },
              ]
            : []
        )
        if (files.length === 0) return []
        return [
          {
            id: family.id,
            title: family.title,
            repo: family.repo,
            revision: family.revision,
            ...(family.featured ? { featured: true } : {}),
            files,
            projectors: family.projectors.map(({ file, size, sha256, ...rest }) => ({
              file,
              size,
              sha256,
              ...(rest.default ? { default: true } : {}),
            })),
          },
        ]
      }),
    }
  }

  async ruleFor(query: Pick<CompatibilityQuery, 'sha256' | 'repo' | 'file'>): Promise<RuleMatch | undefined> {
    return findPrismModelRule(await this.deps.rules.rules(), query)
  }

  /**
   * Throws `MODEL_ENGINE_INCOMPATIBLE` / `MODEL_FORMAT_LEGACY` when the file at `modelPath` cannot
   * run on `provider`; resolves otherwise (also when nothing could be read).
   */
  async gate(
    provider: LocalProviderId,
    target: { modelPath: string; sha256?: string; modelId?: string }
  ): Promise<void> {
    if (!GATED_PROVIDERS.has(provider)) return
    const rules = await this.deps.rules.cachedRules()
    const rule = target.sha256 ? findPrismModelRule(rules, { sha256: target.sha256 }) : undefined
    let evidence: GgufEvidence | undefined
    if (!rule) {
      try {
        evidence = await (this.deps.inspectLocal ?? inspectLocalGguf)(target.modelPath)
      } catch (err) {
        this.deps.log?.(
          'warn',
          `[compatibility] header of ${target.modelPath} unreadable, not gating: ${String(err)}`
        )
        return
      }
    }
    const verdict = resolveCompatibility({
      rules,
      ...(rule ? { rule } : {}),
      ...(evidence ? { evidence } : {}),
      prism: await this.deps.installedPrism({ offline: true }),
    })
    const refusal = gateDecision(verdict, provider)
    if (!refusal) return
    throw new AtomicCoreError(
      refusal.code,
      refusal.message,
      JSON.stringify({ ...(target.modelId ? { model_id: target.modelId } : {}), provider, verdict })
    )
  }

  private async evidenceFor(query: CompatibilityQuery): Promise<GgufEvidence | undefined> {
    try {
      if (query.modelPath) return await (this.deps.inspectLocal ?? inspectLocalGguf)(query.modelPath)
      if (query.inspectRemote && query.repo && query.file) {
        const token = this.deps.hfToken?.()
        return await (this.deps.inspectRemote ?? inspectRemoteGguf)(
          hfResolveUrl(query.repo, query.file, query.revision),
          {
            fetch: this.deps.fetch,
            ...(token ? { token } : {}),
            ...(this.deps.remoteTimeoutMs !== undefined ? { timeoutMs: this.deps.remoteTimeoutMs } : {}),
          }
        )
      }
    } catch (err) {
      this.deps.log?.(
        'warn',
        `[compatibility] could not read the header: ${err instanceof Error ? err.message : String(err)}`
      )
    }
    return undefined
  }
}
