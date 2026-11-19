# Use the GGUF context limit for manual Strata loads

The catalog supplies the default context for a Strata profile. Explicit loads may request up to the training context advertised by the installed first weights shard. The registry extracts this value from the GGUF header it already verifies during load. The authenticated context-limit route reads the same header without hashing all weights for a UI query. A missing training context falls back to the catalog value. Existing device-specific automatic sizing still applies.
