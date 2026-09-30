---
date: 2026-09-30
title: "tensorrt-llm: the default card is the one with the most free memory, for the load and the check alike"
---

# 2026-09-30 — tensorrt-llm: the default card is the one with the most free memory, for the load and the check alike

Supersedes the GPU-selection half of `2026-09-28-tensorrt-llm-model-check-kv-reserve-and-gpu-selection.md`
(its KV-reserve half was already superseded by the 2026-09-29 records).

- **Context:** With no `gpu_id` saved, or a saved card that `nvidia-smi` no longer lists, a
  `tensorrt-llm` load and `POST /atomic/v1/models/tensorrt-llm/check` both fell back to
  `selectLaunchGpu`, which ranked cards by `total_vram_bytes` and let a unified-memory card rank as
  `0`. On the most common multi-GPU desktop — two equal cards, the first holding the desktop and a
  browser — that sends the model to the busy card and runs it out of memory while the second card sits
  idle. The final review's M-2 found the gap; the spec session fixed the rule (spec
  `tensorrt-llm-runtime` "Выбор карты и настройки провайдера", scenario "Первая карта занята рабочим
  столом"; design D12b; task 2.21): the most FREE memory at load time, ties by the most TOTAL memory,
  and the check without `gpu_id` uses the same rule.
- **Decision:**
  1. `selectLaunchGpu(gpus, host, gpuId?)` stays the one function both paths call — `runtime.ts`'s
     load (on the host facts it probes right before the load) and `check.ts` (through
     `checkModelCompatibility`, after the request's `gpu_id` and the stored one) — so the verdict and
     the launch cannot be about different cards. A present `gpu_id` still wins outright.
  2. Otherwise: the most free memory; on equal free memory the most total memory; on a full tie the
     card `nvidia-smi` lists first. The last tie-break is the listing order (`nvidia-smi` enumerates by
     PCI bus, stable on a host, and it is the "GPU 0" the user sees) rather than the UUID, which is
     just as deterministic but would pick an arbitrary-looking card among identical ones.
  3. No compute-capability filter, although M-2 suggested "largest among eligible cards": the spec
     rule is memory only. A card the checkpoint's format cannot run on gets an honest
     `MODEL_INCOMPATIBLE` that names the cards it would fit on (`fits_other_gpus`).
  4. A unified-memory card (`total_vram_bytes: null`, design D13) ranks by the host's memory:
     `MemAvailable` as its free memory — the very figure its memory check already compares against —
     and `MemTotal` as its total. The pure functions take a `HostMemory { availableBytes, totalBytes }`
     instead of a bare `MemAvailable` number, and the host probe (`readHostMemory`) now reads both
     lines of `/proc/meminfo`; an unreadable line is `0`, so such a card under-ranks rather than
     over-ranks.
- **Consequences:**
  - Placement may change between loads as the cards' load changes. The engine cache is keyed by
    descriptor and model, not by card, so this only moves where the model runs.
  - The load ranks cards on facts probed before its `stopping-previous` stage: a `tensorrt-llm`
    session already loaded still holds its card's memory at that moment, although this load stops it
    anyway (one `tensorrt-llm` session at a time). Switching models with no `gpu_id` saved can
    therefore move to the other card, or be refused by the post-eviction memory check on the chosen
    card while the card the previous model is leaving would have fit. The check, answering from the
    same live facts, picks the same card, so the two never disagree; they only both see the host as it
    is before the switch. Crediting back the memory of the session a load is about to replace would
    need a per-session VRAM figure the core does not measure today.
  - A card another engine (llama.cpp, MLX, diffusion) is holding now naturally ranks lower, so a
    default load prefers a card it does not have to evict anything from.
  - The `gpu_id` description and placeholder in `src/settings/schema/tensorrt-llm.json` now say "most
    free memory"; the app's copy of that schema (task 3.2) must mirror the new text and checksum.
- **Owner:** team.
- **Links:** openspec change `add-tensorrt-llm-linux` (`atomic-chat-spec`), task 2.21, design D12b/D13;
  spec `tensorrt-llm-runtime` "Выбор карты и настройки провайдера";
  `src/runtime/tensorrt-llm/{compatibility,host-facts,check,runtime}.ts`;
  `test/e2e/tensorrt-llm-provider.test.ts` ("the tensorrt-llm default card").
