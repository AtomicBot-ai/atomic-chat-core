---
date: 2026-11-19
title: Reuse Strata engine profiles from the model catalog
---

# Reuse Strata engine profiles from the model catalog

A Strata installation is keyed by its variant ID. The optional `profile_id`
selects an existing family-specific engine profile for validation, preparation,
memory estimates and launch. The persisted descriptor and digest retain both
identities. Older installed descriptors default to their original variant ID.

Catalog authors place explicit profiles in the optional `strata-profile-models`
collection with kind `strata-profile`. Earlier readers ignore that kind and
collection. The installation ID must be unique across all Strata collections.
Changing a model source or profile changes its descriptor digest.
