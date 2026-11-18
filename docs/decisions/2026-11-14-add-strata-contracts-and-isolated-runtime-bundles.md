---
date: 2026-11-14
title: "Separate Strata acquisition, preparation and session ownership"
---

# 2026-11-14 — Separate Strata acquisition, preparation and session ownership

- **Context:** Strata requires a pinned Control/Python/compute bundle and local model conversion. A downloaded model is not yet a runnable model. App and server installers own model acquisition; core owns engine builds and inference sessions.
- **Decision:** Add the `strata` provider through existing engine-build and session interfaces. Accept only complete pinned family descriptors and immutable runtime bundles. Keep acquisition metadata in `model.yml.strata`; keep preparation and maintenance as separate durable core operations. Expose their additive control client API without restoring the `./downloads` npm export. Validate the entire bundle inventory before activation and preserve the prior build on activation failure. Use published expanded archive sizes for disk preflight.
- **Consequences:** Clients can recover preparation from operation lists and revisions rather than confusing downloads with ready models. New runtime releases cannot silently replace the bytes or compatibility metadata of an accepted release id. The production manifest currently has no releases; candidate fixtures and fake processes are not evidence of real inference qualification. No existing runtime or model data is migrated.
- **Owner:** team.
- **Links:** `atomic-chat-spec/openspec/changes/add-strata-runtime/{design.md,tasks.md,rulings/conf.md}`; `src/contracts/strata.ts`; `src/client/strata-contracts.ts`; `src/engine-builds/strata-manifest.ts`.

The Control bundle retains a private launch receipt for each process. Core registers
the launch command before allowing it to create a Control owner. The stop path
checks the recorded start identity of every descendant before releasing the GPU
and build. If the owner disappears during a spawn and leaves only its intent,
core conservatively retains ownership rather than treating the missing identity
as a confirmed exit. This requires Atomic owner contract 3 in the installed bundle.
The macOS watcher also terminates the compute process if it cannot establish its
own supervision. Recovery addresses only the recorded profile's processes.

The session gateway has its own credentials. Inference reaches only the chat and
model metadata routes, with a different key on the upstream loopback connection.
The gateway validates image sources and rejects unavailable structured output
before forwarding. Pinned Control owns full schema validation and stream buffering.
