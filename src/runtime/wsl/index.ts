/**
 * WSL from Windows (openspec change `add-tensorrt-llm-windows`): the transport every piece of the
 * Windows managed environment reaches Atomic Chat's own distribution through — `wsl.exe` argv with no
 * shell, its UTF-16 output decoded, deadlines, an injectable executable, and the attached process
 * that keeps the distribution running (design D1, D8, D16).
 *
 * Public API of this module is exported from this file only.
 */
export * from './transport.js'
