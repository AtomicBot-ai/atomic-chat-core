---
date: 2026-11-12
title: "Group parallel tool results before passing history to Foundry"
---

# 2026-11-12 — Group parallel tool results before passing history to Foundry

- **Context:** Foundry Local 2.4's positional templates require a complete, contiguous group of results after each parallel tool-call turn. A Claude Messages client can replay user content across several messages. When an earlier user message carries both a result and text, the chat shim emits that text before the results of later user messages.
- **Decision:** At the Foundry gateway, match each parallel tool-call ID to exactly one result in the following user and tool messages. Move the complete result group ahead of the user messages. Preserve each group's internal order and let Foundry correlate results by ID.
- **Consequences:** Foundry can replay the split turn without changing the generic Anthropic shim or affecting other engines. Missing, duplicate, and unrelated IDs retain the engine's original validation. User content and tool results are preserved.
- **Owner:** team.
- **Links:** [Claude Messages API](https://platform.claude.com/docs/en/api/typescript/messages/create).
