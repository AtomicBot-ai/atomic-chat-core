---
date: 2026-11-17
title: "Export agent integrations for embedding hosts"
---

# Export agent integrations for embedding hosts

- **Context:** An embedding host establishes its own public listener and model session. It needs to configure and launch the same agents as core without calling the CLI's listener or model lifecycle.
- **Decision:** Expose the integration module as a package subpath. Let the existing launch-argument planner accept the URL of a host that serves the Muse model catalogue.
- **Consequences:** Embedding hosts use the same detection, configuration and launch settings as core. The standalone CLI continues to refuse Muse when its serving path does not provide that catalogue.
- **Release:** Dispatch with `maintenance` to publish older minor lines under `maintenance-<major>.<minor>` on npm and preserve the current latest GitHub release.
- **Owner:** team.
