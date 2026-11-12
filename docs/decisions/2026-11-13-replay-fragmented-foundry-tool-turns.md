---
date: 2026-11-13
title: "Replay fragmented and partial tool turns through Foundry"
---

# 2026-11-13 — Replay fragmented and partial tool turns through Foundry

- **Context** — Foundry Local 2.4 joins consecutive assistant fragments from the same speaker before validating positional tool results. The gateway matched calls one message at a time. Foundry also rejects partial groups with at least one real result, even when the available result has an exact call ID.
- **Decision** — Gather the calls from the assistant fragments that Foundry treats as one turn. When a positional group is invalid, correlate all results with their unique earlier calls and place each group immediately after its issuing turn, keeping the order of other messages. In a partially answered group, mark calls with no result in the request. Translate Anthropic tool choice and its parallelism flag for Foundry.
- **Consequences** — A model can see the real results and tell which outcomes are absent. An unresolved call alone requires no marker unless moving a result would otherwise merge its turn with the next assistant turn. Unknown, premature and duplicate results are still left for Foundry to validate. Delayed results may be rendered earlier so that the positional template can bind them. Other providers keep their existing tool choice behavior.
- **Owner** — team.
- **Links** — [Original grouping decision](2026-11-12-group-foundry-parallel-tool-results.md).

<!--
Supersedes: 2026-11-12-group-foundry-parallel-tool-results.md
-->
