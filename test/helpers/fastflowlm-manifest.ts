/** Synthetic engine release metadata; the integration tests supply the actual archive digest. */
export function flmRelease(revision = 1) {
  const version = 'flm-1.0.11-r' + revision
  const base = 'https://github.com/AtomicBot-ai/atomic-chat-core/releases/download/' + version + '/'
  const blob = (name: string) => ({ url: base + name, sha256: 'a'.repeat(64), size: 123 })
  return {
    version,
    upstream_commit: 'b'.repeat(40),
    atomic_revision: revision,
    local_only_protocol: 1,
    min_core_version: '0.1.0',
    published_at: '2026-11-05T00:00:00Z',
    provenance: {
      core_commit: 'c'.repeat(40),
      patch_sha256: 'd'.repeat(64),
      dependencies_sha256: 'e'.repeat(64),
      document: blob('provenance.json'),
    },
    assets: ['win-x64-npu', 'linux-x64-npu'].map((platform) => ({
      platform,
      ...blob(version + '-' + platform + (platform === 'win-x64-npu' ? '.zip' : '.tar.gz')),
    })),
  }
}
