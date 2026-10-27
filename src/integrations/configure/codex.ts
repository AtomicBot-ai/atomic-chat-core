/**
 * Codex CLI — a profile file of our own, `<codex_home>/atomic-chat.config.toml`.
 *
 * Codex 0.134+ layers `$CODEX_HOME/<name>.config.toml` over the base `config.toml` when it is run
 * with `--profile <name>`, so `launch` runs `codex --profile atomic-chat` (catalog `runArgs`) and the
 * model, the provider and its endpoint live in a file nothing else writes. The provider id is
 * `atomic-chat`, not `atomic`, so it never merges into a `[model_providers.atomic]` the user has.
 *
 * The shared `config.toml` is no longer ours to write. Earlier versions edited it (two managed
 * regions: bare root `model` / `model_provider` at the top, `[model_providers.atomic]` at the end),
 * and a user who already had a root `model` got a duplicate key that stopped Codex — and the ChatGPT
 * desktop app, which reads the same file — from starting. The only thing done to it now is removing
 * those regions, through the strict repair in `codex-repair.ts`, before the profile is written.
 *
 * Order: version gate, repair, profile. Below 0.134 `--profile` meant the old `[profiles.x]` tables,
 * so an old Codex is refused before anything is touched; a version that cannot be read is let through.
 * The profile is rewritten only while its first line says Atomic Chat wrote it: a file of the same
 * name that someone else made is refused, never replaced. The bytes are a contract with the desktop
 * writer (ADR 2026-10-27-codex-runs-on-a-profile-of-its-own), so either side can rewrite the other's.
 */

import { join, resolve } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { AtomicCoreError } from '../../contracts/index.js'
import { expandTilde, tomlBasicStringEscape } from '../config-io.js'
import type { ConfigFs } from '../config-io.js'
import { repairLegacyCodexConfig } from './codex-repair.js'
import type { ConfigureInput } from './registry.js'
import { registerWriter } from './registry.js'

/** The profile name `--profile` takes, and the stem of its file. */
export const CODEX_PROFILE = 'atomic-chat'
/** A profile file is ours iff it starts with this. */
export const CODEX_PROFILE_OWNER_PREFIX = '# Managed by Atomic Chat'
/**
 * The first release where `--profile <name>` reads `<name>.config.toml`; 0.131–0.133 called that
 * `--profile-v2` and meant the old `[profiles.x]` tables by `--profile`.
 */
export const CODEX_MIN_VERSION = [0, 134, 0] as const

export type CodexVersion = readonly [number, number, number]

/**
 * Codex's own home: `$CODEX_HOME` when set and non-empty, else `<home>/.codex`. Codex resolves a
 * relative `$CODEX_HOME` against its working directory, which `launch` shares with it. A leading `~`
 * is expanded against the home directory: a quoted `CODEX_HOME="~/x"` reaches us unexpanded.
 */
export function codexHome(env: NodeJS.ProcessEnv, home: string): string {
  const raw = env['CODEX_HOME']
  return raw === undefined || raw === '' ? join(home, '.codex') : resolve(expandTilde(raw, home))
}

export function codexProfilePath(dir: string): string {
  return join(dir, `${CODEX_PROFILE}.config.toml`)
}

/**
 * The profile's exact bytes. Codex reads the key from the variable `env_key` names, never inline, so
 * a keyless server gets no `env_key` line at all and `launch` sets the variable on the child.
 */
export function renderCodexProfile(apiUrl: string, model: string, apiKey: string): string {
  return (
    `${CODEX_PROFILE_OWNER_PREFIX}: \`codex --profile ${CODEX_PROFILE}\` runs Codex on your local models.\n` +
    '# Atomic Chat rewrites this file when Codex is connected again and deletes it on disconnect.\n' +
    `model = "${tomlBasicStringEscape(model)}"\n` +
    `model_provider = "${CODEX_PROFILE}"\n` +
    '\n' +
    `[model_providers.${CODEX_PROFILE}]\n` +
    'name = "Atomic Chat"\n' +
    `base_url = "${tomlBasicStringEscape(apiUrl)}"\n` +
    (apiKey === '' ? '' : 'env_key = "ATOMIC_CHAT_API_KEY"\n')
  )
}

/** `codex --version` prints `codex-cli 0.146.0`: the first `x.y.z` in the output. */
export function parseCodexVersion(output: string): CodexVersion | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(output)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined
}

export function isCodexTooOld([major, minor, patch]: CodexVersion): boolean {
  const [minMajor, minMinor, minPatch] = CODEX_MIN_VERSION
  if (major !== minMajor) return major < minMajor
  if (minor !== minMinor) return minor < minMinor
  return patch < minPatch
}

/**
 * Write the profile, refusing to replace a file of that name Atomic Chat did not write. Returns its
 * path. A profile that cannot be read is an error, never "absent".
 */
export async function writeCodexProfile(
  fs: ConfigFs,
  dir: string,
  apiUrl: string,
  model: string,
  apiKey: string
): Promise<string> {
  const path = codexProfilePath(dir)
  const contents = renderCodexProfile(apiUrl, model, apiKey)
  // Cannot fail with the escaping above; it keeps a future edit of the template from shipping a file
  // Codex would reject.
  parseToml(contents)

  let existing: string | undefined
  try {
    existing = await fs.readStrict(path)
  } catch (e) {
    throw new AtomicCoreError('IO_ERROR', `Failed to read ${path}`, (e as Error).message)
  }
  if (existing !== undefined && !existing.startsWith(CODEX_PROFILE_OWNER_PREFIX)) {
    throw new AtomicCoreError(
      'IO_ERROR',
      `${path} already exists and was not written by Atomic Chat. Rename or remove it, then connect Codex again.`
    )
  }
  await fs.write(path, contents)
  return path
}

/**
 * The installed Codex's version, or `undefined` when it cannot be told: no runner, a launcher that
 * does not start or fails, output without a version. On Windows the npm launcher is `codex.cmd`,
 * which only `cmd` can run (as for Cline).
 */
async function installedCodexVersion(input: ConfigureInput): Promise<CodexVersion | undefined> {
  if (!input.spawn) return undefined
  const program = input.program ?? 'codex'
  const windows = input.platform === 'win32'
  try {
    const result = await input.spawn(
      windows ? 'cmd' : program,
      windows ? ['/C', program, '--version'] : ['--version']
    )
    return result.code === 0 ? parseCodexVersion(result.stdout) : undefined
  } catch {
    return undefined
  }
}

export async function configureCodex(input: ConfigureInput): Promise<void> {
  const version = await installedCodexVersion(input)
  if (version && isCodexTooOld(version)) {
    throw new AtomicCoreError(
      'IO_ERROR',
      `Codex CLI ${version.join('.')} is too old for Atomic Chat. Update it to 0.134 or newer and connect again.`
    )
  }

  const dir = codexHome(input.env, input.fs.home)
  const repair = await repairLegacyCodexConfig(input.fs, dir, input.platform)
  if (repair.kind === 'conflict') throw new AtomicCoreError('IO_ERROR', repair.reason)

  await writeCodexProfile(input.fs, dir, input.apiUrl, input.model, input.apiKey)
}

registerWriter('codex', configureCodex)
