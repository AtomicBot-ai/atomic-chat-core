---
date: 2026-09-22
title: "Split the managed runtime layout: the environment is the user's, the models are the scope's"
---

# 2026-09-22 — Split the managed runtime layout: the environment is the user's, the models are the scope's

- **Context:** The managed text runtimes (TensorRT-LLM first) need somewhere on disk for the
  container environment, the engines installed into it, the running containers and the model
  snapshots. The app scope and the CLI scope have separate data folders by
  [2026-09-17-isolate-app-and-cli-owners](2026-09-17-isolate-app-and-cli-owners.md), and `<data>` is
  movable — the user can relocate it from the app. But the thing being installed is one Docker
  engine on Linux, or one WSL distribution with its Docker on Windows, belonging to the machine's
  user account. Putting all of it under `<data>` would mean two copies of a 16 GB runtime image for
  one user, and would make a data-folder move imply reinstalling a container environment.
- **Decision:** Two roots.
  - **Shared, per user account:** `<dataDir>/atomic-managed-runtimes/` holding `environment.json`,
    `environment.lock`, `installations/<installation_id>/installation.json` and
    `operations/<operation_id>.json`. `dataDir` is the same one `data-folder.ts` already resolves
    (Roaming AppData, Application Support, XDG data). `ATOMIC_CORE_MANAGED_ROOT` overrides it, so
    tests and e2e never touch a real machine's environment. It deliberately ignores
    `ATOMIC_CORE_DATA_FOLDER`.
  - **Per scope:** `<data>/atomic-core/managed-runtimes/` holding `executions/`, `heartbeats/`,
    `artifacts/` and `caches/<engine_id>/<descriptor_id>/<artifact_id>/`.

  Every id becomes one directory name through `encodeManagedId`: every UTF-8 byte outside
  `[A-Za-z0-9._-]` is percent-encoded, and `.`, `..`, a trailing dot and the Windows device names
  are escaped as well. A guest path is never returned as a host path (`managedHostPath` throws).
- **Consequences:** Two cores can reach the same environment record, so every mutation of it takes
  `environment.lock` first (implemented by T04b). A data-folder move relocates models and containers
  but leaves the environment alone, which is what
  [the app's T19a](../../../Atomic-Chat/docs/decisions/2026-09-22-sequence-tensorrt-llm-agent-tasks.md)
  guards. App and CLI still cannot stop each other's containers or share a half-written download,
  because executions, heartbeats, artifacts and caches stay per scope. Percent-encoding means a
  directory listing is not always readable at a glance; `decodeManagedId` is the inverse.
- **Owner:** team.
- **Links:** `src/config/paths.ts`, `src/config/paths.test.ts`, `docs/contracts.md`;
  app ADRs `2026-09-22-share-managed-text-runtime-infrastructure` and
  `2026-09-22-propose-managed-tensorrt-llm-architecture` (§0), card T01c.
