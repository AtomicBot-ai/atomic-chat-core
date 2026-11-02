---
date: 2026-11-01
title: "Read HF metadata at an immutable model revision"
---

# Read HF metadata at an immutable model revision

- **Context:** The GGUF reader omitted the repository commit and returned main URLs. Client metadata and bytes could therefore describe different files.
- **Decision:** Accept optional revision, require a full returned SHA, and return that SHA and immutable URLs. Keep the array and existing fields. Expose the browser-safe unified catalog projection through the client entry. Clients own and persist download plans; no model download API is added to the core.
- **Consequences:** Missing or mismatched commits fail before a client starts a transfer. Old callers retain the signature; network fixtures must now provide the real commit. Existing model paths, inference contracts and engine behavior are unchanged.
- **Alternatives:** Client response interception hides the commit contract and loses explicit revisions. A core downloader violates client ownership.
- **Owner:** team.
