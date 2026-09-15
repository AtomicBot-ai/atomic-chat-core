# Contract tests

Replay every fixture under `test/fixtures/app/` against the TypeScript port and assert byte-identical
output. Per phase 0 of PLAN.md: argv per config × build number, stderr → `{code,message}`, readiness lines,
`--list-devices` samples, `model.yml` round-trip, Responses↔Chat shim pairs, `local-api-server.json`,
download event sequences, `[disk_*]` tags, `SessionInfo` key set.
