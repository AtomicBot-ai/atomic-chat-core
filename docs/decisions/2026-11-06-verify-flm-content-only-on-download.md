# Verify FLM content only during download

## Context

FLM registry lookup hashed every installed file. Model listing, compatibility checks and load preparation all used that lookup. Opening the server engine picker therefore reread tens of gigabytes of weights, with concurrent requests repeating the work.

## Decision

The installer owns SHA-256 verification of downloaded files before publication. Atomic Server already passes pinned sizes and hashes to its downloader, which validates both fresh downloads and reused transfer files.

The core registry no longer hashes installed contents or reads payload bytes. It retains completion-marker parsing, generated configuration consistency, path containment, regular-file and inventory checks, sizes, and bounded config metadata validation. This applies to lookup, listing, compatibility checks and load preparation.

## Consequences

Ordinary UI reads and launch preparation scale with file count and small metadata rather than total weight size. No hash cache, invalidation policy or second post-download hash pass is needed. A same-size payload modification after installation will no longer be detected by the registry. Missing files, wrong sizes and redirected paths still fail structural checks. Engine archive and privileged-request verification are unchanged.
