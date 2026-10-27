---
date: 2026-10-27
title: "Codex runs on a profile of its own; the shared config.toml is only repaired"
---

# 2026-10-27 — Codex runs on a profile of its own; the shared config.toml is only repaired

- **Context:** The Codex writer (core `configure/codex.ts`, the app's Rust `configure_codex`) edited
  the user's shared `~/.codex/config.toml`: a `# >>> Atomic Chat (managed) >>>` region at the top with
  root `model` + `model_provider = "atomic"`, and one at the end with `[model_providers.atomic]` (V2;
  the first Launch page wrote one region at the end with `[profiles.atomic]`, V1). A user with a root
  `model` of their own got `duplicate key`, and Codex — the CLI and the ChatGPT desktop app, which
  read the same file — refused to start; removing the tool in Atomic Chat never undid the edit. The
  golden fixtures `agent-config/codex__*` pinned exactly that output.
- **Decision:** Atomic Chat owns `<codex_home>/atomic-chat.config.toml` (`codex_home` = non-empty
  `$CODEX_HOME`, a leading `~` expanded, else `<home>/.codex`) and runs `codex --profile atomic-chat`
  (catalog `runArgs`), which Codex ≥ 0.134.0 layers over the base config; the provider id is
  `atomic-chat`, never `atomic`. The profile's bytes, the TOML escaping (`\\ \" \b \t \n \f \r`, other
  controls and DEL as `\uXXXX` upper-case), the ownership rule (ours iff it starts with
  `# Managed by Atomic Chat`; anyone else's is refused, never replaced), the `env_key` line only for a
  keyed server, and the child's `ATOMIC_CHAT_API_KEY` are a contract with the desktop writer, which
  produces identical files. `config.toml` is never written except by the legacy repair: markers count
  only as whole lines (a trailing `\r` ignored; a marker inside other text is a conflict), they must
  pair without nesting, each region must parse as TOML on its own and hold only what V1/V2 wrote
  (`model` string, `model_provider = "atomic"`, `model_providers.atomic` = name "Atomic Chat" +
  `base_url` + optional `env_key = "ATOMIC_CHAT_API_KEY"`, `profiles.atomic` = model +
  `model_provider = "atomic"`); the regions are removed with their line endings, blank lines at the
  top dropped when the file began with a region, trailing whitespace trimmed to one `\n`; the result
  must parse and the file must read the same again; the original goes to
  `config.toml.atomic-chat-backup` (then `-2`, `-3`, … — never over an earlier one) and the result is
  written atomically with the file's permission bits. Any doubt is a conflict that leaves the file
  byte for byte as it was and tells the user which lines to remove. `configure` = version gate
  (`codex --version` < 0.134.0 refused; unknown is let through) → repair (conflict = error) →
  profile. TOML is parsed with `smol-toml` 1.x (zero dependencies), a new runtime dependency the owner
  asked for; the eight `codex__*` app fixtures are retired (agent-config index note, `CHECKSUM`) and
  `configure/codex.test.ts` + `codex-repair.test.ts` pin the new behaviour.
- **Consequences:** A user's Codex config is no longer ours to break; the first configure after this
  release repairs the incident shape and keeps a backup. Codex older than 0.134 cannot be launched
  from `launch codex` until updated (0.131–0.133 named the flag `--profile-v2`). A config.toml that
  is a symlink is replaced by a regular file on repair (the backup and the link's target keep the old
  text). The app's copy of the agent-config fixtures still has the codex cases; it drops them with
  the desktop half of this change. Startup migration, disconnect (delete our profile, repair) and the
  "configured" detection are the desktop's alone.
- **Owner:** team
- **Links:** `src/integrations/configure/{codex,codex-repair}.ts`, `src/integrations/config-io.ts`
  (`readStrict`, `createNew`, `permissions`, `tomlBasicStringEscape`), `src/integrations/catalog.ts`,
  `src/cli/launch.ts`, `test/contract/agent-config.test.ts`, `test/fixtures/app/agent-config/index.json`.
