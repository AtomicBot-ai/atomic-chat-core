---
date: 2026-10-28
title: "Embedding loads never take a tensor split from the extra arguments"
---

# 2026-10-28 — Embedding loads never take a tensor split from the extra arguments

- **Context:** The provider's extra llama-server arguments go to every load of that provider,
  including the attachment-indexing model (`sentence-transformer-mini`, `isEmbedding`). A Windows
  user with two CUDA GPUs put `-sm tensor` there so chat models run tensor-parallel. Chat models load
  fine with it, but the embedding server aborts on start —
  `ggml-backend-meta.cpp:610: unsupported mul_mat split states: node=node_30 src0=blk.0.attn_output.weight
  axis=0 src1=Meta(CUDA0,CUDA1)#kqv_out-0#0 axis=10` — so every attachment fails with "Failed to index
  attachments" (app 2.2.26, core 0.19.0, upstream llama.cpp `win-cuda-13.4-x64`). `-sm tensor` comes after the app's own
  `--split-mode none`, and llama.cpp takes the last value. The settings dropdown offers none / layer /
  row only, so the extra arguments are the only way a tensor split reaches a load.
- **Decision:** `planLlamaArgs` removes `-sm tensor`, `--split-mode tensor` and their `=tensor`
  spellings from the extra arguments of an embedding load and records a warning. The split mode
  from settings, the other extra arguments, and every argument of a text load are left as they are.
- **Consequences:** Users who run chat models tensor-parallel can index attachments again; the
  embedding model uses the settings split mode (layer by default). A tensor split for an embedding
  model is no longer possible at all; nothing is lost, since llama.cpp cannot run one. Other chat-only
  flags in the extra arguments still reach embedding loads; filter them here too if one is found to
  break the embedding server.
- **Owner:** `team`.
- **Links:** Linear ATO-556; `src/runtime/llamacpp/args.ts` (`withoutTensorSplit`, `planLlamaArgs`).
