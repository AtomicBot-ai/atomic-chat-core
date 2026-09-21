/**
 * The coding agents `launch` can wire to a local model — a port of
 * `src-tauri/src/core/cli/integrations.rs`, which itself mirrors
 * `web-app/src/constants/integrations.ts` so the CLI and the desktop Launch page configure the same
 * set in the same order. The three GUI editors in the web list (`vscode`, `jetbrains`, `xcode`) are
 * absent on purpose: they keep their provider in IDE storage with no writable config file.
 *
 * Order is contract: the app's drift test compares this list against the TypeScript source
 * position by position, and `tests/cli-launch-catalog.test.mjs` compares it against the CLI.
 */

export type RunMode =
  /** A terminal program: run it in the foreground and keep the model up exactly as long as it runs. */
  | 'terminal'
  /** A GUI app: the launcher returns at once, so the model stays up until Ctrl+C. */
  | 'gui'

export interface Agent {
  /** Stable id, identical to the one in `integrations.ts`. */
  id: string
  /** Display name (product names are not localised). */
  name: string
  /** Binary probed on PATH, and the program we execute. */
  detectBin: string
  /** Extra names accepted on the command line. */
  aliases: readonly string[]
  /** Whether a model id must be resolved before the agent can be configured. */
  requiresModel: boolean
  /** Pass the endpoint WITH the API prefix (`/v1`). Claude Code and Goose append their own path. */
  endpointWithPrefix: boolean
  docsUrl: string
  /** Argv appended after `detectBin` so the user lands in a session, not a help screen. */
  runArgs: readonly string[]
  runMode: RunMode
}

/** Hermes Agent refuses to start below a 64K context window. Matches the Launch page. */
export const HERMES_CONTEXT_LENGTH = 65_536

export const AGENTS: readonly Agent[] = [
  {
    id: 'kilo',
    name: 'Kilo Code',
    detectBin: 'kilo',
    aliases: [],
    requiresModel: true,
    endpointWithPrefix: true,
    docsUrl: 'https://kilo.ai/docs',
    runArgs: [],
    runMode: 'terminal',
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    detectBin: 'claude',
    aliases: ['claude', 'claudecode'],
    requiresModel: false,
    // Claude Code appends its own `/v1`.
    endpointWithPrefix: false,
    docsUrl: 'https://docs.anthropic.com/en/docs/claude-code',
    runArgs: [],
    runMode: 'terminal',
  },
  {
    id: 'pi',
    name: 'pi',
    detectBin: 'pi',
    aliases: [],
    requiresModel: true,
    endpointWithPrefix: true,
    docsUrl: 'https://github.com/earendil-works/pi',
    runArgs: [],
    runMode: 'terminal',
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    detectBin: 'codex',
    aliases: [],
    requiresModel: true,
    endpointWithPrefix: true,
    docsUrl: 'https://github.com/openai/codex',
    runArgs: [],
    runMode: 'terminal',
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    detectBin: 'opencode',
    aliases: [],
    requiresModel: true,
    endpointWithPrefix: true,
    docsUrl: 'https://opencode.ai',
    runArgs: [],
    runMode: 'terminal',
  },
  {
    id: 'openclaude',
    name: 'OpenClaude',
    detectBin: 'openclaude',
    aliases: [],
    requiresModel: true,
    endpointWithPrefix: true,
    docsUrl: 'https://github.com/Gitlawb/openclaude',
    runArgs: [],
    runMode: 'terminal',
  },
  {
    id: 'cline',
    name: 'Cline CLI',
    detectBin: 'cline',
    aliases: [],
    requiresModel: true,
    endpointWithPrefix: true,
    docsUrl: 'https://docs.cline.bot/cline-cli/getting-started',
    runArgs: [],
    runMode: 'terminal',
  },
  {
    id: 'dsh',
    name: 'DeepSeek Harness',
    detectBin: 'dsh',
    aliases: [],
    requiresModel: true,
    endpointWithPrefix: true,
    docsUrl: 'https://github.com/deepseek-ai/deepseek-harness',
    // A bare `dsh` has no profile to hand its arguments to and only prints the launcher's help;
    // `dsh web` serves the UI on 127.0.0.1:3080.
    runArgs: ['web'],
    runMode: 'terminal',
  },
  {
    id: 'zed',
    name: 'Zed',
    detectBin: 'zed',
    aliases: [],
    requiresModel: true,
    endpointWithPrefix: true,
    docsUrl: 'https://zed.dev/docs/ai/llm-providers',
    runArgs: [],
    // Zed's AI agent lives in its own window; the launcher returns at once.
    runMode: 'gui',
  },
  {
    id: 'zcode',
    name: 'ZCode',
    // The desktop app's executable: `/usr/bin/zcode` on Linux, found off PATH elsewhere
    // (see `offPathCandidates`).
    detectBin: 'zcode',
    aliases: [],
    requiresModel: true,
    endpointWithPrefix: true,
    docsUrl: 'https://zcode.z.ai/en/docs/configuration',
    runArgs: [],
    // A desktop app that reads the provider file we write; it returns at once.
    runMode: 'gui',
  },
  {
    id: 'mimo',
    name: 'MiMo Code',
    detectBin: 'mimo',
    aliases: [],
    requiresModel: true,
    endpointWithPrefix: true,
    docsUrl: 'https://mimo.xiaomi.com/mimocode/',
    runArgs: [],
    runMode: 'terminal',
  },
  {
    id: 'droid',
    name: 'Droid',
    detectBin: 'droid',
    aliases: [],
    requiresModel: true,
    endpointWithPrefix: true,
    docsUrl: 'https://docs.factory.ai/cli/getting-started/quickstart',
    runArgs: [],
    runMode: 'terminal',
  },
  {
    id: 'copilot',
    name: 'Copilot CLI',
    detectBin: 'copilot',
    aliases: [],
    requiresModel: true,
    endpointWithPrefix: true,
    docsUrl: 'https://docs.github.com/en/copilot/how-tos/copilot-cli',
    runArgs: [],
    runMode: 'terminal',
  },
  {
    id: 'openhands',
    name: 'OpenHands',
    detectBin: 'openhands',
    aliases: [],
    requiresModel: true,
    endpointWithPrefix: true,
    docsUrl: 'https://docs.openhands.dev/openhands/usage/cli/installation',
    // OpenHands reads the env overrides only with this flag.
    runArgs: ['--override-with-envs'],
    runMode: 'terminal',
  },
  {
    id: 'poolside',
    name: 'Poolside',
    detectBin: 'pool',
    aliases: ['poolside'],
    requiresModel: true,
    endpointWithPrefix: true,
    docsUrl: 'https://docs.poolside.ai/cli',
    runArgs: [],
    runMode: 'terminal',
  },
  {
    id: 'goose',
    name: 'Goose',
    detectBin: 'goose',
    aliases: [],
    requiresModel: true,
    // Goose appends its own path via OPENAI_BASE_PATH.
    endpointWithPrefix: false,
    docsUrl: 'https://block.github.io/goose/',
    // A bare `goose` only prints help.
    runArgs: ['session'],
    runMode: 'terminal',
  },
  {
    id: 'muse',
    name: 'Muse Code',
    detectBin: 'muse',
    aliases: ['muse-code', 'musecode'],
    requiresModel: true,
    // `--base-url` replaces the Meta Model API root; Muse appends `/responses` itself.
    endpointWithPrefix: true,
    docsUrl: 'https://developer.meta.com/ai/products/muse-code/',
    runArgs: [],
    runMode: 'terminal',
  },
  {
    id: 'atomic-agent',
    name: 'Atomic Agent',
    detectBin: 'atomic-agent',
    // `atag` is the short alias the installer drops next to the binary.
    aliases: ['atag'],
    requiresModel: true,
    endpointWithPrefix: true,
    docsUrl: 'https://github.com/AtomicBot-ai/atomic-agent',
    runArgs: [],
    runMode: 'terminal',
  },
  {
    id: 'hermes',
    name: 'Hermes Agent',
    detectBin: 'hermes',
    aliases: [],
    requiresModel: true,
    endpointWithPrefix: true,
    docsUrl: 'https://github.com/NousResearch/hermes-agent',
    runArgs: [],
    runMode: 'terminal',
  },
  {
    id: 'openclaw',
    name: 'OpenClaw',
    detectBin: 'openclaw',
    aliases: [],
    requiresModel: true,
    endpointWithPrefix: true,
    docsUrl: 'https://docs.openclaw.ai',
    // A bare `openclaw` is the setup/repair helper; `chat` runs the agent.
    runArgs: ['chat'],
    runMode: 'terminal',
  },
]

/** Look an agent up by id, binary name, or alias. Case-insensitive. */
export function findAgent(name: string): Agent | undefined {
  const needle = name.trim().toLowerCase()
  return AGENTS.find((a) => a.id === needle || a.detectBin === needle || a.aliases.includes(needle))
}

/** The endpoint an agent is pointed at: the base URL, plus the prefix only when it expects one. */
export function apiUrlFor(agent: Agent, baseUrl: string, prefix: string): string {
  return agent.endpointWithPrefix ? `${baseUrl}${prefix}` : baseUrl
}

/**
 * Provider credentials in the ambient environment that would override the config we just wrote.
 * Cleared on the child before launching, or the agent quietly talks to a cloud provider instead.
 */
export const CONFLICTING_PROVIDER_ENV: readonly string[] = [
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_OAUTH_TOKEN',
  'GEMINI_API_KEY',
  'MISTRAL_API_KEY',
  'GROQ_API_KEY',
  'XAI_API_KEY',
  'OPENROUTER_API_KEY',
]

/**
 * Environment the spawned agent needs on top of its config file. Five agents are configured purely
 * through environment variables that `configure_*` persists to the user's shell rc — that file is
 * not live in a process we are about to spawn, so the same variables are set on the child.
 */
export function childEnv(
  agent: Agent,
  apiUrl: string,
  model: string,
  apiKey: string
): Record<string, string> {
  const key = apiKey || 'atomic'
  switch (agent.id) {
    case 'copilot':
      return {
        COPILOT_PROVIDER_BASE_URL: apiUrl,
        COPILOT_PROVIDER_TYPE: 'openai',
        COPILOT_MODEL: model,
        COPILOT_OFFLINE: 'true',
        // Copilot is the one that omits the key entirely when there is none.
        ...(apiKey ? { COPILOT_PROVIDER_API_KEY: apiKey } : {}),
      }
    case 'goose':
      return {
        GOOSE_PROVIDER: 'openai',
        GOOSE_MODEL: model,
        OPENAI_HOST: apiUrl,
        OPENAI_BASE_PATH: 'v1/chat/completions',
        OPENAI_API_KEY: key,
      }
    case 'openhands':
      // The litellm `openai/` prefix is required for a custom OpenAI-compatible base_url.
      return { LLM_MODEL: `openai/${model}`, LLM_BASE_URL: apiUrl, LLM_API_KEY: key }
    case 'poolside':
      return {
        POOLSIDE_STANDALONE_BASE_URL: poolsideStandaloneBaseUrl(apiUrl),
        POOLSIDE_API_KEY: key,
        POOLSIDE_STANDALONE_MODEL: model,
      }
    case 'muse':
      return { META_API_KEY: key }
    default:
      return {}
  }
}

/** Poolside wants the root without `/v1`; it appends its own paths. */
export function poolsideStandaloneBaseUrl(apiUrl: string): string {
  const trimmed = apiUrl.trim().replace(/\/+$/, '')
  const withoutV1 = trimmed.endsWith('/v1') ? trimmed.slice(0, -'/v1'.length) : trimmed
  return withoutV1.replace(/\/+$/, '')
}

/**
 * Launchers that installers drop outside PATH. OpenClaw's installer writes into `~/.openclaw/bin`
 * or `~/.local/bin` (or `$OPENCLAW_PREFIX`), which a login shell may not have on PATH yet. ZCode is a
 * desktop app that puts nothing on PATH outside Linux, so its candidates are the executables its
 * installers write. Every other agent installs onto PATH, and guessing would only produce false
 * positives.
 */
export function offPathCandidates(
  bin: string,
  home: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string[] {
  const separator = platform === 'win32' ? '\\' : '/'
  const join = (...parts: string[]) => parts.map((p) => p.replace(/[\\/]+$/, '')).join(separator)
  if (bin === 'zcode') return zcodeAppCandidates(home, env, platform, join)
  if (bin !== 'openclaw' || !home) return []
  const roots: string[] = []
  const prefix = env['OPENCLAW_PREFIX']
  if (prefix && prefix.trim() !== '') roots.push(prefix)
  roots.push(join(home, '.openclaw'), join(home, '.local'))
  // Windows launchers are `.cmd` shims; POSIX ones are extensionless.
  const names = platform === 'win32' ? ['openclaw.cmd', 'openclaw.exe', 'openclaw'] : ['openclaw']
  const out: string[] = []
  for (const root of roots) for (const name of names) out.push(join(root, 'bin', name))
  return out
}

/**
 * Where each ZCode installer puts the desktop app's executable (`zcode_app_candidates` in the app's
 * `core/system/commands.rs`, commit `ec1fd3ea7`). The Linux deb/rpm packages also link
 * `/usr/bin/zcode`, which the PATH probe finds first.
 */
function zcodeAppCandidates(
  home: string | undefined,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  join: (...parts: string[]) => string
): string[] {
  if (platform === 'darwin') {
    const out = ['/Applications/ZCode.app/Contents/MacOS/ZCode']
    if (home) out.push(join(home, 'Applications/ZCode.app/Contents/MacOS/ZCode'))
    return out
  }
  if (platform === 'win32') {
    // NSIS installs per user under `%LOCALAPPDATA%\Programs` and for all users under `%ProgramFiles%`.
    const out: string[] = []
    for (const [variable, sub] of [
      ['LOCALAPPDATA', 'Programs\\ZCode'],
      ['ProgramFiles', 'ZCode'],
    ] as const) {
      const root = env[variable]
      if (root) out.push(join(root, sub, 'ZCode.exe'))
    }
    return out
  }
  return ['/opt/ZCode/zcode']
}

/**
 * `launch` runs a bare llama-server, and Muse Code fetches `/muse-code/models` before its first
 * turn — a catalogue only the desktop app's Local API Server serves. Refusing up front beats
 * loading a model and handing the user Muse's own opaque failure.
 */
export const MUSE_CLI_REFUSAL = [
  'Muse Code needs the desktop app’s Local API Server, which serves the',
  '`/muse-code/models` catalogue Muse requires at startup. `launch` runs a',
  'bare llama-server, which does not.',
  '',
  'Start the server in Atomic Chat, then use Integrations → Muse Code.',
]
