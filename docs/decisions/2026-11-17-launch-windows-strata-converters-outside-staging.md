---
date: 2026-11-17
title: "Launch Windows Strata converters outside the staging directory"
---

# 2026-11-17 — Launch Windows Strata converters outside the staging directory

- **Context:** The derivative staging path includes model and source digests plus the preparation operation ID. On Windows this can exceed the working directory limit for process creation, so the converter fails before it has a PID.
- **Decision:** Use the Windows system directory as the converter's working directory. Pass extended-length paths to Python so it can access staging even on Windows installations that use the default file path limit. Keep the staging-only write guard. Detect a failed spawn before requesting the converter identity.
- **Consequences:** Existing preparations can resume in their original staging directories. The converter still waits for its durable process identity before running a recipe.
- **Owner:** team.
