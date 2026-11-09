---
date: 2026-11-06
title: "Release FLM maintenance after rollback to absence"
---

# 2026-11-06 — Release FLM maintenance after rollback to absence

- **Context:** The server obtains replacement maintenance before publishing a first model installation. If final acceptance fails, the client restores the previous state, which can be an absent model. Requiring an installed model on completion left that guard permanently held and blocked client recovery.
- **Decision:** Completing either maintenance kind accepts an absent installation directory. Every existing directory still passes the full read-only registry check; partial, corrupt and redirected installations keep the guard held. Completion releases a filesystem mutation guard and does not claim that a model is installed or runnable.
- **Consequences:** Initial-install rollback is idempotently recoverable without inventing a removal transaction or changing the wire protocol. Subsequent load of an absent model still follows the normal missing-model refusal.
- **Alternatives:** Retaining invalid files or using a remove guard for an install would obscure the operation's intent. Neither is necessary.
- **Owner:** team.
- **Links:** `src/core/create-fastflowlm-maintenance.test.ts`; OpenSpec `add-fastflowlm-runtime`, CLI 7.4.

The owner journals `initially_absent` before granting mutation. Replacement of a previously present model still requires a valid restored or replacement model. Older journal records retain that strict behavior.

Windows acceptance also found that a FileHandle stream wrapper retained a sharing lock after verification in the compiled runtime. SHA-256 verification now reads bounded blocks directly from the already validated descriptor and closes that same descriptor. This preserves inode/symlink checks, bounded memory, and runtime independence while allowing immediate client rename/removal. A compiled Windows registry-then-rename probe failed before this change.
