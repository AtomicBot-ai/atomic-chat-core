/**
 * Small shared helpers with no I/O. Rust-compatible number parsing/formatting lives here because
 * several ports (argv, GGUF, log parsers) must reproduce `str::parse` / `to_string` exactly.
 */
export * from './rust-number.js'
