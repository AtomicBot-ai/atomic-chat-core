---
date: 2026-11-17
title: "Account for staged Strata sources in compatibility checks"
---

# 2026-11-17 — Account for staged Strata sources in compatibility checks

- **Context.** A resumed Strata download needs less free disk space because the client has already staged some of the pinned sources.
- **Decision.** Allow the authenticated control client to supply a bounded `staged_bytes` count on a descriptor check. Subtract the count from the remaining source estimate and apply the usual disk and memory checks to the result.
- **Consequences.** The client measures reusable bytes for its own staging directory. Core keeps the derivative and temporary space estimates, and validates the complete input files during preparation.
- **Alternative.** Retrying without the disk verdict would lose the preparation space reservation and could hide an independent memory failure.
