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
    // The model and provider live in our own profile file (`configure/codex.ts`), which Codex reads
    // only when asked to; the shared `config.toml` is the user's.
    runArgs: ['--profile', 'atomic-chat'],
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
    // Handed the bare host like Claude Code; `childEnv` adds the server's prefix to OPENAI_BASE_URL.
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
  // Goose reads an OPENAI_HOST from the environment before OPENAI_BASE_URL, and its base path with it.
  'OPENAI_HOST',
  'OPENAI_BASE_PATH',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_OAUTH_TOKEN',
  'GEMINI_API_KEY',
  'MISTRAL_API_KEY',
  'GROQ_API_KEY',
  'XAI_API_KEY',
  'OPENROUTER_API_KEY',
]

/** What `childEnv` may need beyond the endpoint: the served window and the server's API prefix. */
export interface ChildEnvOptions {
  /** The window the served model was loaded with, when known. */
  contextLength?: number | undefined
  /** The API prefix for an agent handed the bare host (Goose); `/v1` when not given. */
  apiPrefix?: string | undefined
}

/**
 * Environment the spawned agent needs on top of its config file. Four agents are configured through
 * environment variables that `configure_*` persists to the user's shell rc — that file is not live in
 * a process we are about to spawn, so the same variables are set on the child. Goose gets its own
 * only here, for the one session. Codex's profile names the variable its key is read from
 * (`env_key`) but never holds the key, so the key goes on the child — only when there is one, as the
 * profile names the variable only then.
 */
export function childEnv(
  agent: Agent,
  apiUrl: string,
  model: string,
  apiKey: string,
  options: ChildEnvOptions = {}
): Record<string, string> {
  const key = apiKey || 'atomic'
  switch (agent.id) {
    case 'copilot':
      // The endpoint, key and limits are our entry in Copilot's providers.json
      // (`configure/copilot.ts`); this selects it for the run, as `--model` would.
      return { COPILOT_MODEL: `atomic-chat/${model}` }
    case 'goose': {
      // Goose derives its chat path from OPENAI_BASE_URL, prefix included; with the window and output
      // cap it compacts before the server refuses.
      const ctx = options.contextLength !== undefined && options.contextLength > 0 ? options.contextLength : 0
      return {
        GOOSE_PROVIDER: 'openai',
        GOOSE_MODEL: model,
        OPENAI_BASE_URL: `${apiUrl}${options.apiPrefix ?? '/v1'}`,
        OPENAI_API_KEY: key,
        ...(ctx
          ? {
              GOOSE_CONTEXT_LIMIT: String(ctx),
              GOOSE_MAX_TOKENS: String(Math.min(8192, Math.floor(ctx / 4))),
            }
          : {}),
      }
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
    case 'codex':
      return apiKey ? { ATOMIC_CHAT_API_KEY: apiKey } : {}
    default:
      return {}
  }
}

/**
 * The arguments that start `agent` on `model`: its fixed `runArgs`, plus `--model atomic/<id>` for
 * Kilo, which otherwise opens on the model it last used before the one its config selects.
 */
export function runArgsFor(agent: Agent, model: string): string[] {
  return agent.id === 'kilo' && model ? ['--model', `atomic/${model}`, ...agent.runArgs] : [...agent.runArgs]
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
 * installers write. Zed's DMG links no `zed` CLI, and its install script's `~/.local/bin` is often
 * not on PATH. Every other agent installs onto PATH, and guessing would only produce false
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
  if (bin === 'zed') return zedLauncherCandidates(home, env, platform, join)
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

/** ZCode's two builds: product name and Linux executable. */
const ZCODE_FLAVORS = [
  ['ZCode', 'zcode'],
  ['ZCode Preview', 'zcode-preview'],
] as const

/**
 * Where each ZCode installer puts the desktop app's executable, the "ZCode Preview" build included
 * (`zcode_app_candidates_for` in the app's `core/system/commands.rs`, which also scans for AppImages
 * and the Windows uninstall list). The Linux deb/rpm packages also link `/usr/bin/zcode`, which the
 * PATH probe finds first.
 */
function zcodeAppCandidates(
  home: string | undefined,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  join: (...parts: string[]) => string
): string[] {
  const out: string[] = []
  if (platform === 'darwin') {
    const roots = ['/Applications', ...(home ? [join(home, 'Applications')] : [])]
    for (const root of roots)
      for (const [product] of ZCODE_FLAVORS) out.push(join(root, `${product}.app/Contents/MacOS/${product}`))
    return out
  }
  if (platform === 'win32') {
    // NSIS installs per user under `%LOCALAPPDATA%\Programs` and for all users under `%ProgramFiles%`.
    const roots = [
      env['LOCALAPPDATA'] ? join(env['LOCALAPPDATA'], 'Programs') : undefined,
      env['ProgramFiles'],
    ]
    for (const root of roots)
      if (root) for (const [product] of ZCODE_FLAVORS) out.push(join(root, product, `${product}.exe`))
    return out
  }
  for (const [product, exe] of ZCODE_FLAVORS) {
    out.push(`/opt/${product}/${exe}`)
    if (exe !== 'zcode') out.push(`/usr/bin/${exe}`)
  }
  return out
}

/**
 * Zed's launchers off PATH (`zed_cli_candidates` and `zed_app_candidates` in the app's
 * `core/system/commands.rs`): its CLI, then the editor itself.
 */
function zedLauncherCandidates(
  home: string | undefined,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  join: (...parts: string[]) => string
): string[] {
  if (!home) return []
  if (platform === 'darwin') {
    const roots = ['/Applications', join(home, 'Applications')]
    return [
      join(home, '.local/bin/zed'),
      ...roots.flatMap((root) => [
        join(root, 'Zed.app/Contents/MacOS/cli'),
        join(root, 'Zed Preview.app/Contents/MacOS/cli'),
      ]),
      ...roots.map((root) => join(root, 'Zed.app/Contents/MacOS/zed')),
    ]
  }
  if (platform === 'win32') {
    // The installer's `{autopf}\Zed`: per user unless run elevated.
    const local = env['LOCALAPPDATA'] || join(home, 'AppData\\Local')
    const dirs = [
      join(local, 'Programs\\Zed'),
      ...(env['ProgramFiles'] ? [join(env['ProgramFiles'], 'Zed')] : []),
    ]
    return [...dirs.map((dir) => join(dir, 'bin\\zed.exe')), ...dirs.map((dir) => join(dir, 'Zed.exe'))]
  }
  return [
    join(home, '.local/bin/zed'),
    join(home, '.local/zed.app/bin/zed'),
    join(home, '.local/zed-preview.app/bin/zed'),
  ]
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
