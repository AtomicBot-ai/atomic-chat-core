# 2026-11-07 — Reuse the public API after host key rotation

- **Context:** Hosts can supply a dynamic public API keyring. It takes precedence over the static start key on every request, but lifecycle idempotency still compared that static key. Repeating start after revoking the original key incorrectly returned `CORE_ALREADY_RUNNING`.
- **Decision:** Retain the exact keyring callback supplied to the running listener. While it returns a defined list, ignore only the static key when comparing repeated start options. An empty list remains authoritative and denies every client. If the callback is absent or returns undefined, static-key equality is still required. Other listener options must always match.
- **Consequences:** A host can reuse its listener after key rotation without interrupting requests. The static fallback key is not changed by a repeated start; if the host later returns undefined, the original fallback still applies. Changing that fallback requires an explicit restart. Stop clears the retained callback.
- **Validation:** A targeted real-core test rotates A to B, repeats start without a second started event, checks A is rejected and B accepted, and checks incompatible prefixes and static keys remain conflicts.
- **Owner:** team.
