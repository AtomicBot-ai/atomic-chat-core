---
date: 2026-10-21
title: "Answer an unknown model and an empty conversation with OpenAI errors"
---

# 2026-10-21 — Answer an unknown model and an empty conversation with OpenAI errors

- **Context:** QA of app 2.2.23 (core 0.18.7) found two gaps in the public server. A request naming a
  model nothing serves got a plain-text 404 (`No running session found for model 'X'`) on
  `/chat/completions`, `/completions`, `/embeddings`, `/messages/count_tokens`, `/messages` and
  `/responses`, while the server's other failures already answer `{"error": {...}}` (AC-13). The text
  is the recorded Rust proxy behaviour (`proxy-http` fixtures `chat_unknown_model_not_found`,
  `messages_unknown_model_not_found`, `responses_unknown_model`). And a chat with `messages: []` to a
  local model was forwarded; llama.cpp answered 200 with a completion nobody asked for (AC-12).
- **Decision:** The unknown-model 404 is OpenAI's envelope — `type: invalid_request_error`,
  `code: model_not_found`, `param: model`, `Content-Type: application/json` — and keeps the old text
  as `error.message` (`modelNotFoundJson`). `/chat/completions` and `/messages` with an empty
  `messages` array to a local session are refused with 400, `code: empty_array`, `param: messages`, in
  OpenAI's wording (`emptyMessagesRefusal`), before the engine is asked. The unknown-model answer comes
  first; a remote provider still validates its own requests; a body with no `messages` at all is left
  to the engine. The 503 `No models are available` and the other plain-text 400s are unchanged.
- **Consequences:** Clients that parse OpenAI errors get a typed `model_not_found`. Clients matching
  the old text keep working when they read `error.message`: the app's agent client
  (`openai_client.rs` `classify_error`, through `extract_error_detail`) does, and the app pins that
  with a test. A client that compared the raw body to the text breaks. The three fixtures are not
  re-recorded; `test/contract/proxy-http.test.ts` corrects their expectation as a known divergence.
  The app's own proxy (mobile) answers the same way since the same change. Tests that used
  `messages: []` as a filler body for a local model now send one message. `/responses` with an empty
  `input` is not refused yet.
- **Owner:** team
- **Links:** `src/server/public/errors.ts`, `forward.ts`, `responses.ts`; app
  `src-tauri/src/core/server/proxy.rs` (`model_not_found_json`, `empty_messages_refusal`).
