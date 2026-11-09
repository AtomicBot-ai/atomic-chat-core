---
date: 2026-11-05
title: "Validate FastFlowLM installer plans before projection"
---

# 2026-11-05 — Validate FastFlowLM installer plans before projection

- **Context:** Desktop and server installers need the same paths, immutable source revisions and content hashes. Older unified catalogs omit the FastFlowLM collection.
- **Decision:** Project an absent FLM collection as an empty list. For FLM entries validate the source table, every file and the component inventory before returning a detached installer plan. Resolve developer sources from explicit configuration. On desktop a relay reads file URLs. On Node the host reads them from disk.
- **Consequences:** A malformed FLM plan fails catalog validation before the client writes files. Applications can use a staging candidate while its qualification status stays visible. The provider and control client types can ship before a host registers a build installer or runtime.
- **Evidence:** The Qwen3 fixture in `test/fixtures/fastflowlm/qwen3-candidate.json` was copied from `.github/fixtures/fastflowlm/model-candidate.json` in atomic-chat-conf commit `01b781e679bfd40eb70bc75df5fbab05f4e62504`. The regression compares the entire projected definition with that fixture.
