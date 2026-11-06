---
date: 2026-11-05
title: "Verify the local-only FLM executable before publishing an engine build"
---

# Verify the local-only FLM executable before publishing an engine build

The engine installer reads the Atomic release manifest and selects a Windows 11 x64 or Linux x64 archive independently of driver readiness. The downloader verifies the archive size and SHA-256. From the staged tree the core runs the absolute executable with `atomic-capabilities --json` and checks its upstream commit, Atomic revision and local-only protocol against the selected release. A stock executable reporting the same upstream version cannot establish these facts.

The installer records the verified identity, takes the engine lock and swaps the directory into place. The install remains cancellable until that swap. A rejected activation restores the previous directory. A later start recovers a previous directory parked by an interrupted replacement. Older releases remain installed until explicitly removed. Each manifest override has its own disk cache to keep development releases out of production fallback. Checking the NPU and installing models are separate operations.
