---
date: 2026-11-18
title: "Initialize NumPy before watching stdin in Windows Strata converters"
---

# 2026-11-18 — Initialize NumPy before watching stdin in Windows Strata converters

- **Context:** On Windows, the native NumPy import in the Strata model and draft packers can block while another thread is reading stdin. The converters then stay alive without reading the model or producing output.
- **Decision:** After the owner acknowledges the process and the audit hook is installed, import NumPy in the Windows packers before starting the stdin watcher. Start the watcher before running the converter script so it still exits when its owner closes the pipe.
- **Consequences:** Pack preparation uses the existing journal, cancellation, and staging rules. The early NumPy import is limited to the two Windows packers that need it.
- **Owner:** team.
