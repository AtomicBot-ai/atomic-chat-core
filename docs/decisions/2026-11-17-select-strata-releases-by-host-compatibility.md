---
date: 2026-11-17
title: "Select Strata releases by host compatibility"
---

# 2026-11-17 — Select Strata releases by host compatibility

- **Context:** Strata publishes platform bundles on independent revisions. A newer Metal revision can precede the compatible Windows or Linux CUDA revision in the same manifest.
- **Decision:** Select the first compatible release in the manifest's descending revision order and carry that release together with the backend selection. Catalog, updates, archive verification, and install receipts all use that same release.
- **Consequences:** Hosts can install and update Strata on independent platform revisions. Archive pins and installed release identities are preserved.
- **Owner:** team.
