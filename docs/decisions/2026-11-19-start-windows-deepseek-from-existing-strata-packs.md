---
date: 2026-11-19
title: "Start Windows DeepSeek from existing Strata packs"
---

# Start Windows DeepSeek from existing Strata packs

The pinned DeepSeek engine joins the packed model directory and each shard name with a forward slash. Win32 accepts that separator in ordinary paths and rejects it in verbatim paths such as the ones the Windows converter writes.

When starting an affected Windows model, the core copies the verified prepared metadata into the private runtime scope and uses the ordinary drive or UNC path in the copy. The model shards and the prepared cache retain their original bytes. The core removes the launch copy once it confirms the runtime has exited. Existing prepared packs use the same launch path as newly prepared packs.

The legacy executable still depends on Win32's ordinary path-length support. Full support for extended-length paths requires the native engine to use Windows separators when it joins the shard names.

Owner: team.
