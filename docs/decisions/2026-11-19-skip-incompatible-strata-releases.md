---
date: 2026-11-19
title: "Select Strata releases compatible with the running core"
---

# Select Strata releases compatible with the running core

The Strata manifest can serve several core generations. Each release declares its minimum core version, adapter contract version and preparation ABI. Within manifest schema 1 the core checks those fields and release identity before interpreting the version-specific payload. It validates compatible payloads in full and offers the newest build that also supports the host. A valid manifest with no compatible releases offers no installation or update.

The disk cache retains the source document. Published IDs remain immutable across compatibility boundaries, and a newer core can reevaluate the cached releases offline. A malformed compatibility header, duplicate ID or invalid compatible payload still fails the refresh. Core binaries released before this change retain their original parsing behavior.

Owner: team.
