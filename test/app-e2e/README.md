# App-E2E

Proves the Tauri app and this core see the same world. Needs `../Atomic-Chat` checked out and, for the
UI scenarios, a built app. See `docs/app-e2e.md`. These tests are skipped unless `ATOMIC_APP_E2E=1`.

Claude subscription acceptance is in the companion app's
`tests/e2e/desktop/claude-subscription.spec.ts`. Set `ATOMIC_CORE_REPO` to this
checkout and `ATOMIC_CORE_BIN` to its compiled app-core binary. The scenario
uses `test/helpers/fake-claude-code.mjs`, never an actual account, and checks
versioned Fable selection, the Claude logo, streaming, resume, credential-free
status and exclusion from the public provider registry. It requires the app's
dedicated `app-e2e` build; ordinary core verification does not run the UI.
