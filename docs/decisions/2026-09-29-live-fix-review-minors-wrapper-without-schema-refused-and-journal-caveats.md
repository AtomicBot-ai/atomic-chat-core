---
date: 2026-09-29
title: "Live-fix review minors: a wrapper without a schema is refused, and the journal record's caveats"
---

# 2026-09-29 — Live-fix review minors: a wrapper without a schema is refused, and the journal record's caveats

- **Context:** Review of the live-run fixes found one behaviour gap and two gaps in the wording of the
  records below (they are append-only, so they are amended here). (1) The json_schema record forwards
  a `json_schema` with no object `schema` as a bare schema, so `{"name": "r", "strict": true}` alone
  (or `{"name": "r", "schema": true}`) reached xgrammar as a grammar over the keywords `name`/`strict`,
  which constrains nothing — the very silent failure that record exists to remove. OpenAI itself
  answers `400` to such a wrapper. (2) The docker-journal record says an older core's request "is
  refused" after the recipe digest changed, without saying what the client must do, and does not say
  that `journalctl -n 40` can include lines from an earlier start attempt or boot, or where its
  privacy argument stops.
- **Decision:** (1) In `unwrapJsonSchemaFormat`, a `json_schema` object with no object `schema` that has
  a `name` or `strict` key is refused with `400 invalid_request_error` (`AtomicCoreError`
  `INVALID_ARGUMENT`, "response_format.json_schema.schema must be an object when
  response_format.json_schema carries name or strict."), like the other shape errors. `name` and
  `strict` are not JSON Schema keywords, so a real bare schema does not carry them and still passes
  unchanged; a wrapper whose only oddity is a non-object `schema` and has neither key
  (`{"schema": true}`) is still taken as a bare schema. (2) Wording only, no behaviour change: the
  digest change means every host-step request planned by an older core must be re-planned — the client
  asks the new core for a fresh plan and the user consents again — because the old digest is no longer
  the recipe's. The 40 lines are the last 40 of docker.service's journal, not of this attempt: they can
  include an older failure or an earlier boot, and the 2000-character tail keeps the end, where the
  fresh reason usually is. The privacy rationale holds where the invoking user is in `adm` or
  `systemd-journal`; a user outside those groups (a pkexec user, say) gains read access to up to 40
  dockerd log lines through the `0644` result file. That is accepted: the lines are bounded, come from
  one fixed unit, and carry the daemon's own error text.
- **Consequences:** A client that sent a wrapper without a schema now gets a `400` naming the missing
  `schema` instead of an unconstrained answer. A test that pinned "left for the engine to judge"
  changed to expect the `400`. No wire or recipe change from (2).
- **Owner:** `team`.
- **Links:** `src/runtime/tensorrt-llm/adapter.ts` (`unwrapJsonSchemaFormat`),
  `src/runtime/tensorrt-llm/adapter.test.ts`, `test/e2e/tensorrt-llm-provider.test.ts`,
  `src/host/recipes/executor.ts` (`mustStartDocker`); amends
  `2026-09-29-tensorrt-llm-json-schema-wrapper-unwrapped-by-the-session-gateway.md` and
  `2026-09-29-host-step-reads-the-docker-journal-when-docker-does-not-start.md`.

<!--
Supersedes: nothing; amends the two records named in Links.
-->
