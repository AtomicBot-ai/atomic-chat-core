---
date: 2026-11-13
title: "Spell the sd.cpp argv for the installed build"
---

# 2026-11-13 — Spell the sd.cpp argv for the installed build

- **Context:** The engine candidate check of `master-1091-b9d7176` reported five flags core emits as
  deprecated by `sd-server`, marked the same way in the pin `master-1088-32d516c`: `--clip-on-cpu` (use `--backend te=cpu`),
  `--vae-on-cpu` (`--backend vae=cpu`), `--diffusion-fa` (`--flash-attn off,diffusion=on`),
  `--diffusion-conv-direct` (`--conv-direct auto,diffusion=on,controlnet=on`) and `--qwen2vl` (`--llm`).
  Nothing is removed yet, but conf's manifest has no `min_core_version`, so every core gets the next build.
  The replacements are not equally old. `--backend` module assignments, `--llm` and the `te=cpu` entry that
  `--clip-on-cpu` merely prepends are in every build conf has served (849 on). `--flash-attn` and
  `--conv-direct` arrived on 2026-10-13 (leejet/stable-diffusion.cpp#2134), first tagged in 982; conf served
  849 and 883 before that, those trees stay installed (`selectModelInstall` keeps whatever engine a family
  needs no update for), and an older `sd-server` exits on a flag it does not know. Separately, `-M vid_gen`
  sat behind `ATOMIC_DIFFUSION_VID_GEN_MODE_FLAG` until a live run said whether `sd-server` wants it (ADR
  2026-09-23); `-M` is parsed by `sd-cli` only, and `sd-server` takes its modes from the model.
- **Decision:** `buildServerArgs` spells the argv for the build the install's tag names. The CPU modules go
  in one `--backend te=cpu,vae=cpu` and a `qwen2vl` file as `--llm` on every build. Flash attention and
  direct convolution are `--flash-attn off,diffusion=on --conv-direct auto,diffusion=on,controlnet=on` from
  build 982 (`MODULE_ASSIGNMENT_FLAGS_BUILD`), the old two flags before it and on a tag that names no build.
  `-M` and its switch are gone. The engine contract carries the bound per flag (`from_build`,
  `below_build`); the candidate check and the live test read only the flags core emits to the build under
  test.
- **Consequences:** No candidate from 982 on reports a deprecated flag, and older installs keep working
  unchanged. The new spelling means what the old one did: `--diffusion-fa` itself sets `off,diffusion=on`,
  and sd.cpp asks about direct convolution only for the diffusion model, the VAE and ControlNet, where
  `--diffusion-conv-direct` meant on, auto and on. Only `sd-server`'s upscale route still reads the legacy
  boolean, and core never calls it. A repeated `--backend` is joined with commas and a module's entry beats
  the bare default, so the CPU recovery's `--backend cpu`, appended last, still runs everything on the CPU;
  the launch log line shows the joined value (`backend=te=cpu` on macOS). The legacy spellings leave the
  contract once no supported install predates 982.
- **Owner:** team
- **Links:** `src/diffusion/{args,compat}.ts`,
  `test/fixtures/sdcpp/{engine-contract.json,required-flags.txt}`,
  `test/fixtures/sdcpp/help/sd-server-master-1028-37bc88b.txt`, `scripts/lib/sdcpp-surface.mjs`,
  `test/contract/sdcpp-{engine-contract,surface}.test.ts`, `test/e2e/{diffusion-engine,video}.test.ts`,
  `test/live/diffusion.test.ts`; upstream `examples/common/common.cpp` (`prepare_backend_assignments`, the
  deprecated handlers) at `master-1088-32d516c`; engine-candidate report of `master-1091-b9d7176` (Hatchet
  run `350cd60d-91f7-4d77-ac46-5c4c08383cf6`).

<!--
Refines: 2026-09-23-generate-video-through-the-resident-diffusion-session.md (drops the -M switch),
2026-10-21-check-sdcpp-builds-with-the-engine-candidate.md (the deprecated-flag warns it expected)
-->
