---
date: 2026-10-28
title: "Report unknown embedding models without chat sessions"
---

# 2026-10-28 - Report unknown embedding models without chat sessions

- **Context:** Regression B02 reproduced a plain-text 503 for an unknown embedding model while a valid embedding model was advertised and serving. The generic forwarder checked only chat sessions when deciding that no model was available.
- **Decision:** For `/v1/embeddings`, a configured embedding module also counts as model availability. After normal embedding and remote routing decline the requested name, return the existing JSON 404 `model_not_found` envelope, whether or not a chat session is loaded.
- **Consequences:** Clients can diagnose a misspelled model consistently. A wholly unconfigured cold server retains its previous 503 behavior. Requests for the configured embedding model continue through the module's own readiness and validation path.
- **Owner:** team.
- **Links:** `src/server/public/forward.ts`, `src/server/public/embedding.test.ts`, `test/e2e/embedding.test.ts`.
