/** Credential-free wire shapes for the authenticated, control-only Claude Code bridge. */
export interface ClaudeCodeModel {
  id: string
  model: string
  name: string
  description: string
}

export interface ClaudeCodeStatus {
  installed: boolean
  loggedIn: boolean
  subscription: boolean
  plan: string | null
  version: string | null
  error: string | null
  models: ClaudeCodeModel[]
}

export interface ClaudeCodeRequest {
  requestId: string
  model: string
  prompt: string
  system?: string | null
  sessionId?: string | null
}

export interface ClaudeCodeResult {
  sessionId: string
  text: string
  inputTokens: number
  outputTokens: number
}

/** Per-request SSE frames; never broadcast on the shared core event bus. */
export type ClaudeCodeEvent =
  | { type: 'ready' }
  | { type: 'delta'; text: string }
  | { type: 'result'; result: ClaudeCodeResult }
  | { type: 'error'; message: string }
