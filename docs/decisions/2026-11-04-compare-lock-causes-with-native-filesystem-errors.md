---
date: 2026-11-04
title: "Compare lock causes with native filesystem errors"
---

# 2026-11-04 — Compare lock causes with native filesystem errors

- **Context:** The lock cause regression expected ENAMETOOLONG for an overlong file name. Windows returns ENOENT for that same operation, so an otherwise correct cause-preserving implementation failed both Windows CI jobs.
- **Decision:** Compare the wrapped acquisition and takeover errors with the error from the same direct filesystem operation on the running OS. Check the preserved code, message, path, syscall and diagnostic cause code rather than assuming a Unix errno.
- **Consequences:** Every OS must still preserve its actual filesystem failure. Production lock behavior and error serialization are unchanged; the test does not accept a missing or substituted cause.
- **Owner:** `team`.
- **Links:** `src/lock/instance-lock.test.ts`, PR #72, PR #74.
