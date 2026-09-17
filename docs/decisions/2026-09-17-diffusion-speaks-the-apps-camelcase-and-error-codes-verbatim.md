---
date: 2026-09-17
title: "The diffusion surface speaks the app's camelCase and error codes verbatim"
---

# 2026-09-17 — The diffusion surface speaks the app's camelCase and error codes verbatim

- **Context:** The control API inherited snake_case from the llama.cpp plugin's serde output (`model_id`, `api_key`). The diffusion plugin was camelCase throughout, and its shapes are not only a wire format: the recipe is embedded in every PNG (`tEXt` keyword `atomic`), and `install.json` and `.flags.json` sit in users' data folders since v2.0.38. The web app's `lib/diffusion/errors.ts` turns the plugin's 21 codes into actionable messages, and the app's relay keeps a core error's `code` and requires `details` to be a string.
- **Decision:** `src/contracts/diffusion.ts` mirrors `web-app/src/services/diffusion/types.ts` field for field, including which optionals are absent and which are `null` (what the plugin's serde attributes produced). The 21 codes join `ErrorCode` verbatim; three of them already existed with the same spelling (`MODEL_LOAD_FAILED`, `MODEL_NOT_LOADED`, `OUT_OF_MEMORY`) and are shared. Messages are ported verbatim. One control route per plugin command, the same argument names, file-system paths only ever in a body. HTTP statuses are informational (400 for a request the caller can fix, 404 missing, 409 state conflicts, 429 a full queue, 507 a full disk, 500 the rest): the relay acts on `code`, never on the status. Request bodies are parsed strictly, in place of serde: integers where Rust had `u32`/`u64`/`i64`, closed enums, unknown fields ignored; a body that does not parse is `INVALID_REQUEST`.
- **Consequences:** The control API has two casing conventions, by area, and `docs/contracts.md` says which is which. Files written by the plugin keep working, and files written by the core keep working in an app build that still has the plugin. A future rename in `types.ts` is a contract change on both sides.
- **Owner:** team.
- **Links:** `src/contracts/diffusion.ts`, `src/contracts/errors.ts`, `src/diffusion/parse.ts`; app `web-app/src/services/diffusion/types.ts`, `web-app/src/lib/diffusion/errors.ts`, `src-tauri/plugins/tauri-plugin-atomic-diffusion/src/{state,error}.rs` at `767ff6350`.
