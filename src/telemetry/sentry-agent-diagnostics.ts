// SENTRY_AGENT_DIAGNOSTIC_CONFIG {"rules":[{"source":"src/diffusion/install.ts","message":"The image engine could not load a library it needs.","code":"SDCPP_PROBE_LIBRARY_LOAD_FAILED"},{"source":"src/diffusion/install.ts","message":"The image engine exited without printing anything.","code":"SDCPP_PROBE_SILENT_EXIT"},{"source":"src/diffusion/install.ts","message":"The downloaded binary is not stable-diffusion.cpp.","code":"SDCPP_PROBE_UNEXPECTED_OUTPUT"},{"source":"src/diffusion/install.ts","message":"The image engine did not respond to --help.","code":"SDCPP_PROBE_HELP_TIMEOUT"},{"source":"src/diffusion/install.ts","message":"The image engine could not be started.","code":"SDCPP_PROBE_START_FAILED"},{"source":"src/diffusion/install.ts","message":"The archive did not contain sd-server.","code":"SDCPP_ARCHIVE_MISSING_SERVER"},{"source":"src/runtime/geniex/runtime.ts","message":"The GenieX library does not load on this computer.","code":"GENIEX_HOST_LIBRARY_LOAD_FAILED"},{"source":"src/runtime/geniex/runtime.ts","message":"The GenieX host stopped before the model was ready.","code":"GENIEX_HOST_STOPPED_BEFORE_READY"},{"source":"src/runtime/llamacpp/errors.ts","message":"The model process encountered an unexpected error.","code":"LLAMA_CPP_GENERIC_PROCESS_ERROR"}],"include_cause_codes":true}
// This generated observer only enriches an existing error event. It never sends or logs.
const SENTRY_AGENT_MESSAGES = new Map<string, string>([
  ['The image engine could not load a library it needs.', 'SDCPP_PROBE_LIBRARY_LOAD_FAILED'],
  ['The image engine exited without printing anything.', 'SDCPP_PROBE_SILENT_EXIT'],
  ['The downloaded binary is not stable-diffusion.cpp.', 'SDCPP_PROBE_UNEXPECTED_OUTPUT'],
  ['The image engine did not respond to --help.', 'SDCPP_PROBE_HELP_TIMEOUT'],
  ['The image engine could not be started.', 'SDCPP_PROBE_START_FAILED'],
  ['The archive did not contain sd-server.', 'SDCPP_ARCHIVE_MISSING_SERVER'],
  ['The GenieX library does not load on this computer.', 'GENIEX_HOST_LIBRARY_LOAD_FAILED'],
  ['The GenieX host stopped before the model was ready.', 'GENIEX_HOST_STOPPED_BEFORE_READY'],
  ['The model process encountered an unexpected error.', 'LLAMA_CPP_GENERIC_PROCESS_ERROR'],
])
const SENTRY_AGENT_CAUSES = new Set<string>([
  'ENOENT',
  'ENOTDIR',
  'EISDIR',
  'EACCES',
  'EPERM',
  'ENOSPC',
  'EIO',
  'EBUSY',
  'ENOMEM',
  'ECONNREFUSED',
  'ConnectionRefused',
  'ECONNRESET',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
])

/** Finite codes only: messages, paths and arbitrary thrown objects never leave this function. */
export function sentryAgentDiagnosticTags(error: unknown): Record<string, string> {
  const tags: Record<string, string> = {}
  const seen = new Set<Error>()
  try {
    for (let depth = 0; error instanceof Error && depth < 5 && !seen.has(error); depth++) {
      seen.add(error)
      const message: unknown = Object.getOwnPropertyDescriptor(error, 'message')?.value
      if (!tags['diagnostic_code'] && typeof message === 'string') {
        const code = SENTRY_AGENT_MESSAGES.get(message)
        if (code) tags['diagnostic_code'] = code
      }
      const code: unknown = Object.getOwnPropertyDescriptor(error, 'code')?.value
      if (typeof code === 'string' && SENTRY_AGENT_CAUSES.has(code)) tags['diagnostic_cause_code'] = code
      error = Object.getOwnPropertyDescriptor(error, 'cause')?.value
    }
  } catch {
    // A hostile Error getter must not change the result of the observed operation.
  }
  return tags
}
