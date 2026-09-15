# Live tests

Run only with `ATOMIC_LIVE=1`. Real backend download for the pinned tag, real `llama-server` with a small
GGUF (`ATOMIC_LIVE_UPSTREAM_BIN`, `ATOMIC_LIVE_UPSTREAM_MODEL`), cloud providers via
`ATOMIC_CLOUD_PROVIDERS` + `ATOMIC_CLOUD_<NAME>_{BASE_URL,API_KEY,MODEL,_STYLE,_TOOLS}` (same contract as the
app's `scripts/record-cloud-live.py`), recording sanitised cassettes into `test/fixtures/live-cloud/`.
