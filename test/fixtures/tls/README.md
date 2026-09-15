# Test-only TLS material

Generated with `openssl` for the proxy/TLS tests (`src/downloads/proxy-fetch.test.ts`,
`test/helpers/proxy-servers.ts`). Valid 10 years from 2026-09-15. The private keys here protect
nothing: they only exist so loopback test servers can speak TLS. Never reuse outside tests.

- `ca.pem` — test CA (its key is not kept; regenerate everything to re-issue).
- `server.pem` / `server.key` — CA-signed leaf, SAN `localhost`, `127.0.0.1`.
- `selfsigned.pem` / `selfsigned.key` — standalone self-signed leaf (for `ignore_ssl` tests).
