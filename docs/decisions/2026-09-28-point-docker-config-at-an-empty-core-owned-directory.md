---
date: 2026-09-28
title: "Point DOCKER_CONFIG at an empty core-owned directory instead of deleting it; --pull=never on create/run"
---

# 2026-09-28 — Point DOCKER_CONFIG at an empty core-owned directory instead of deleting it; --pull=never on create/run

- **Context:** Task 2.8's Docker executor (`src/runtime/container/`) forces every docker CLI call
  onto the system socket and strips Docker context variables from the child environment, so that no
  user Docker context is ever consulted — spec `tensorrt-llm-runtime`'s isolation requirement. The
  first implementation *deleted* `DOCKER_CONFIG` from the child environment (`env.ts`), on the theory
  that an absent variable means "no config, nothing to consult." Review round 1 (finding 5, Important,
  controller ruling) caught that this is backwards: with `DOCKER_CONFIG` unset, the docker CLI falls
  back to `$HOME/.docker/config.json` — the *user's own* config — which can carry a `credsStore` (a
  registry credential helper the CLI invokes on the user's behalf) and `proxies`
  (`HttpProxy`/`HttpsProxy`/`NoProxy`) that the CLI injects as environment variables into every
  container it creates. Deleting the variable does not isolate the call from the user's Docker
  identity; it adopts it implicitly. Separately, nothing in the original argv stopped `docker
  create`/`docker run` from triggering an *implicit* pull of the image if it were ever invoked before
  `pull.ts`'s own Engine API pull completed (or against a differently-tagged image), which would use
  whatever registry auth that same fallen-back config happened to hold.
- **Decision:** `env.ts`'s `dockerChildEnv` now *sets* `DOCKER_CONFIG` to an empty, core-owned
  directory (`DockerChildEnvOptions.dockerConfigDir`, injectable — real wiring picks a path under
  core's data root; tests point it at a temp directory) rather than deleting the variable.
  `ensureDockerConfigDir` creates that directory (idempotently, `mkdir` with `recursive: true`) before
  every docker call (`exec.ts`'s `runDockerCommand`), so the CLI always finds an existing, empty
  directory with no `config.json` inside — no credential helper, no injected proxies — instead of
  falling back to the user's own config. `dockerConfigDir` is a required option on
  `DockerCommandOptions`/`CreateDockerExecOptions`: there is no default, so a caller cannot forget to
  supply one. Separately, `argv.ts`'s `buildCreateModelContainerArgv` and `buildRunOnceArgv` both now
  always add `--pull=never`: the only thing in this module that fetches image bytes is `pull.ts`'s
  `pullImage`, over the Engine API directly: `docker create`/`docker run` must never trigger an
  implicit pull of their own.
- **Consequences:** `createDockerExec`/`runDockerCommand` gained a required parameter
  (`dockerConfigDir`), a breaking signature change from the initial task 2.8 commit
  (`c1c0e1a`) — every call site in this module (all of `operations.test.ts`'s fakes are unaffected
  since they fake `DockerExec` directly, but `exec.test.ts`/`integration.test.ts` construct
  `createDockerExec` and needed updating). `DockerExec` itself gained an additive optional second
  parameter (`DockerExecCallOptions`, review round 1 item 3, a different finding) — existing fakes
  typed as a one-argument function remain valid `DockerExec`s. Whoever wires this module into the
  shared lifecycle (task 2.9/2.12) must choose and own a real `dockerConfigDir` path (e.g. under
  `<data>/tensorrt-llm/docker-config`) and ensure it survives core restarts pointing at the same empty
  directory, not a fresh one each time (a fresh directory each run is harmless — it is still empty —
  but reusing one avoids needless directory churn under the data root).
- **Owner:** team.
- **Links:** task 2.8 fix round 1 findings, item 5 (`.superpowers/sdd/tasks/findings-2.8-r1.md`);
  `src/runtime/container/env.ts`, `src/runtime/container/exec.ts`, `src/runtime/container/argv.ts`;
  `docs/decisions/2026-09-28-pull-the-model-image-over-the-docker-engine-api.md` (the sibling ADR for
  why `pull.ts` exists at all).
