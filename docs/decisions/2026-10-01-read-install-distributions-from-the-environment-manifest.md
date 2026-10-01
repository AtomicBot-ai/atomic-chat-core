---
date: 2026-10-01
title: "Install distributions come from a per-platform environment manifest, not the engine descriptor"
---

# 2026-10-01 — Install distributions come from a per-platform environment manifest, not the engine descriptor

- **Context:** The TensorRT-LLM descriptor `tensorrt-llm-1.2.1-r1` described two things: the engine
  (image, models, driver floor) and the foundation every engine runs on, `recipes` (the distributions
  where core installs Docker and the NVIDIA Container Toolkit itself). Only the Linux provisioner's
  probe read `recipes`, to decide whether automatic setup may be offered (`InstallGate`). With vLLM,
  SGLang and Windows coming, the distribution list (and later a WSL rootfs) would be copied into every
  engine descriptor, and fixing it would mean a new `descriptor_id` for an engine that did not change.
  The `runtimes/` contract had not shipped (no conf `main`, no released core reads it), so the shape
  could still change without a migration.
- **Decision:**
  1. **One manifest per platform (design D1).** conf publishes `runtimes/environments/linux.json`
     (`manifest_id` `linux-r1`, immutable like a `descriptor_id`) with its own schema. Core on Linux
     reads only that file (`ATOMIC_ENVIRONMENT_MANIFEST_URL` overrides it, `file://` or `https://`).
     The parsers are strict — an unknown key refuses the document — so a single file with a section
     per platform would make a Windows addition refuse the whole document on an older Linux core.
     Separate files keep platforms apart without loosening the parser.
  2. **One fetch-and-cache mechanism (D3).** `cached-document.ts` holds what the descriptor provider
     already got right (accept only what parses and fits `minimum_core_version`, cache forever by id
     in the shared per-user root, lock-free atomic writes, a failed cache write is not fatal, fall back
     to the last accepted). The descriptor provider and the manifest provider
     (`environment-manifests/<manifest_id>.json`, `latest.json`) are two configurations of it; the
     descriptor provider's tests pass with their expectations unchanged.
  3. **Pinned for the operation only (D4).** `RequirementPlan.environment_manifest_id` names the
     manifest a plan was judged against and is part of `plan_digest`. `ConsentBasis` records it
     (optional field, so older operation records still read; absent counts as none). Before a consent
     a probe reads the newest manifest, so one published between the probe and the click returns
     `MANAGED_PLAN_CHANGED`. After the consent a probe reads only the consented manifest from the
     cache, and the consent carries over only to a plan naming the same one, so a manifest published
     during the sign-in wait or across a core restart does not move the work. Nothing pins a manifest
     after the operation: once installed, system Docker is not ours, and nothing reads the
     distribution list for it again.
  4. **No manifest blocks only the install (D5).** Without a manifest (no network and no cache, 404,
     invalid, or only too-new ones) the install gate is `manifest-unavailable`: a host that needs the
     privileged step gets `prerequisite-blocked` with a `MANAGED_METADATA_INVALID` blocker
     (`reason: environment-manifest-unavailable`) and no host step; a host whose Docker already runs
     with the NVIDIA CDI spec is adopted exactly as before. It is a separate cause from
     `distribution-not-in-recipe`, because the user's next step differs (retry with a network vs. use
     a qualified distribution).
  5. **`r2`, no compatibility with `r1` (D6).** The descriptor parser refuses `recipes` as an unknown
     field. conf publishes `tensorrt-llm-1.2.1-r2` (same image, no `recipes`) with
     `minimum_core_version` `0.7.5`; there is no code path that reads the `r1` shape.
- **Consequences:**
  - An installation pinned to `r1` (development machines and the 3.10 acceptance host only) can no
    longer resolve its descriptor: the core reports it unavailable, and the fix is remove + setup,
    which pulls the same image digest again. This is the deliberate cost of not carrying a
    compatibility path that only development machines would ever exercise.
  - A first start with no network now has a second document to miss. It only matters to a host that
    needs the install; the first successful fetch caches it for good.
  - Control API: `RequirementPlan` gains `environment_manifest_id: string | null` (additive; the app
    does not read it). Persistence: `<managed root>/environment-manifests/`, and `ConsentBasis` gains
    an optional field.
  - Until conf merges `runtimes/environments/linux.json` into `main`, a core without the override
    finds no manifest: ready hosts work, automatic setup is unavailable. The merge is the switch.
  - Live tests (`test/live/managed-install.test.ts`, `test/live/tensorrt-llm.test.ts`) read
    `ATOMIC_ENVIRONMENT_MANIFEST_URL` (default: the fixture) and pass it to the core;
    `docs/live-tests.md` names both variables.
- **Owner:** team.
- **Links:** openspec change `extract-environment-manifest` (`atomic-chat-spec`), tasks core 2.1–2.5,
  design D1, D3–D6, rulings `core.md`; `src/runtime/environment/{cached-document,document-fields,
  environment-manifest,environment-manifest-provider,descriptor,descriptor-provider,linux-plan,
  linux-blockers,linux-provisioner,state,wiring}.ts`, `src/contracts/environment.ts`,
  `test/e2e/managed-operations.test.ts` ("the environment manifest through the compiled core").
