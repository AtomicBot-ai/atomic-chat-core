/**
 * The phase-1 commands (PLAN.md §4): `daemon`, `serve`, `models list`, `server status`, `shutdown`.
 *
 * Flags, defaults and exit codes follow the Rust `jan-cli` wherever it has an opinion — `serve`
 * defaults to port 6767, `models list --json` prints the same fields, `server status` exits 1 when
 * the server is unreachable — because both binaries will be installed side by side during the
 * migration. The deliberate difference is ownership: `serve` attaches to a core that keeps running
 * after Ctrl+C instead of owning the model itself, which the help text states outright.
 */

export { apiUrl, baseUrl, formatBytes, layoutFor } from './shared.js'
export { modelsCommand } from './models.js'
export { daemonCommand } from './daemon.js'
export {
  DEFAULT_SERVE_CTX_SIZE,
  DEFAULT_SERVE_GPU_LAYERS,
  DEFAULT_SERVE_PORT,
  DEFAULT_SERVE_TIMEOUT_SECS,
  serveAttachOptions,
  serveCommand,
} from './serve.js'
export { serverCommand } from './server.js'
export { shutdownCommand } from './shutdown.js'
export { printFirstRunNotice, telemetryCommand } from './telemetry.js'
