---
date: 2026-11-22
title: "Refuse a duplicate direct backend install"
---

# 2026-11-22 — Refuse a duplicate direct backend install

- **Context:** `POST /backends/:provider/install` calls `BackendService.install` without an
  operation, while the install stages into `target.incoming-<Date.now()>`. Two installs of the same
  `version/backend` that start in the same millisecond share that directory: the later call's
  `rm(staging, { recursive: true })` deletes what the earlier call has already unpacked, and the
  earlier call's final `rename` then fails with ENOENT from `normalizeBackendLayout` → `moveEntry`,
  reported as `backend install: unknown`. The operation slot already refuses a second update,
  activation or removal of the provider, and the newer staggered engine-install service already
  rejects a duplicate build; this older surface did not.
- **Decision:** A direct install (no `options.operation`) is refused with
  `ENGINE_INSTALL_IN_PROGRESS` while another install of the same `version/backend` is in flight, and
  released once that attempt settles. Installs carried by an update, activation or removal keep
  using the provider's operation slot.
- **Consequences:** A duplicated request fails fast with a coded refusal instead of deleting a
  download in progress; a retry after the earlier attempt settled works, and other packs are
  unaffected. The guard is keyed by pack and only covers concurrent direct calls — it does not
  serialise ordinary sequential installs, and it does not make the staging name unique. The ENOENT
  that a lost data volume produces is not reclassified here: failure classification is telemetry
  and stays out of this change.
- **Owner:** team
- **Links:** `src/backend/install/service.ts`, `src/downloads/archive.ts`,
  `src/telemetry/diagnostics.ts`, `src/backend/install/service-concurrent-install.test.ts`
