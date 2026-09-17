/**
 * The ChatGPT subscription session: status, sign-in, sign-out and a usable access token, with
 * refresh serialised.
 *
 * Ported from: src-tauri/src/core/auth/{state,commands}.rs.
 *
 * Two deliberate differences from the app, both because the token file can have a second process
 * behind it while ownership moves between the app and the core (PLAN.md §2 decision 11):
 * - before refreshing, the file is read again; if another process already rotated the tokens, those
 *   are used instead of spending the (now possibly revoked) refresh token a second time;
 * - a terminal refresh error clears the session only if the file still holds the refresh token that
 *   was refused. Otherwise the refusal was of a token someone else already replaced, and clearing
 *   the file would sign the user out of a session that is fine.
 *
 * Sign-in is two calls instead of the app's one, because a headless core cannot open a browser:
 * `startLogin` binds the callback listener and returns the URL to open, `waitLogin` resolves once
 * the browser has come back and the code has been exchanged.
 */

import { AtomicCoreError } from '../contracts/index.js'
import {
  exchangeCode,
  listenForCallback,
  authorizeUrl,
  newPkce,
  newState,
  refreshTokens,
} from './chatgpt-oauth.js'
import type { CallbackListener, TokenEndpoint } from './chatgpt-oauth.js'
import { clearTokens, isExpiredAt, loadTokens, saveTokens } from './chatgpt-store.js'
import type { StoredTokens } from './chatgpt-store.js'

/** Refresh this far ahead of the stated expiry; an upstream 401 still outranks it. */
export const REFRESH_SAFETY_MARGIN_SECS = 120

/** What callers may know. Deliberately carries no token. */
export interface ChatGptStatus {
  connected: boolean
  email: string | null
  plan_type: string | null
  expires_at: number | null
}

export interface AccessToken {
  token: string
  accountId: string | null
}

export interface ChatGptAuthOptions {
  /** `<data>/atomic-chatgpt-auth.json` */
  path: string
  endpoint?: TokenEndpoint
  now?: () => number
  callbackPort?: number
  callbackTimeoutMs?: number
}

interface PendingLogin {
  listener: CallbackListener
  verifier: string
  challenge: string
}

export class ChatGptAuth {
  private tokens: StoredTokens | undefined
  private hydrated = false
  private chain: Promise<unknown> = Promise.resolve()
  private login: PendingLogin | undefined

  constructor(private readonly options: ChatGptAuthOptions) {}

  private nowUnix(): number {
    return Math.floor((this.options.now ?? Date.now)() / 1000)
  }

  /** Run `task` after every earlier one: the single-flight guarantee for refresh. */
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.chain.then(task, task)
    this.chain = next.catch(() => {})
    return next
  }

  private async hydrate(): Promise<void> {
    if (this.hydrated) return
    this.tokens = await loadTokens(this.options.path)
    this.hydrated = true
  }

  status(): Promise<ChatGptStatus> {
    return this.serial(async () => {
      await this.hydrate()
      return statusOf(this.tokens)
    })
  }

  /** The legacy app just surrendered ownership of this shared app-scope token file. */
  reload(): Promise<ChatGptStatus> {
    return this.serial(async () => {
      this.tokens = await loadTokens(this.options.path)
      this.hydrated = true
      return statusOf(this.tokens)
    })
  }

  set(tokens: StoredTokens): Promise<void> {
    return this.serial(async () => {
      await saveTokens(this.options.path, tokens)
      this.tokens = tokens
      this.hydrated = true
    })
  }

  logout(): Promise<ChatGptStatus> {
    return this.serial(async () => {
      this.tokens = undefined
      this.hydrated = true
      await clearTokens(this.options.path)
      return statusOf(undefined)
    })
  }

  /**
   * A token good for the next request, refreshed first when it is close to expiry. `forceRefresh`
   * skips the expiry check: that is the upstream-401 path, where the server's opinion wins.
   */
  accessToken(forceRefresh = false): Promise<AccessToken> {
    return this.serial(async () => {
      await this.hydrate()
      const current = this.tokens
      if (!current) throw new AtomicCoreError('AUTH_REQUIRED', 'no ChatGPT subscription is connected')

      if (!forceRefresh && !isExpiredAt(current, this.nowUnix(), REFRESH_SAFETY_MARGIN_SECS))
        return { token: current.access_token, accountId: current.account_id }

      // Another process may have rotated the tokens since this one read them.
      const onDisk = await loadTokens(this.options.path)
      if (onDisk && onDisk.refresh_token !== current.refresh_token) {
        this.tokens = onDisk
        if (!isExpiredAt(onDisk, this.nowUnix(), REFRESH_SAFETY_MARGIN_SECS))
          return { token: onDisk.access_token, accountId: onDisk.account_id }
      }
      const spent = this.tokens ?? current

      let refreshed: StoredTokens
      try {
        refreshed = await refreshTokens(spent.refresh_token, this.nowUnix(), this.options.endpoint)
      } catch (e) {
        const error = e as AtomicCoreError
        if (error.code === 'AUTH_REQUIRED') {
          const latest = await loadTokens(this.options.path)
          if (latest && latest.refresh_token !== spent.refresh_token) {
            // Someone else rotated it while we were asking; theirs is the live session.
            this.tokens = latest
            return { token: latest.access_token, accountId: latest.account_id }
          }
          this.tokens = undefined
          await clearTokens(this.options.path).catch(() => {})
          throw new AtomicCoreError('AUTH_REQUIRED', `ChatGPT sign-in expired: ${error.message}`)
        }
        // Unreachable or unrecognised: keep the session, signing out over a blip is worse.
        throw new AtomicCoreError('UPSTREAM_ERROR', `Could not refresh the ChatGPT session: ${error.message}`)
      }
      // A failed write is not fatal for this request, but the next start would need a fresh sign-in.
      await saveTokens(this.options.path, refreshed).catch(() => {})
      this.tokens = refreshed
      return { token: refreshed.access_token, accountId: refreshed.account_id }
    })
  }

  /**
   * Bind the callback listener and return where to send the browser. A sign-in still waiting is
   * cancelled: two browser windows racing for the one callback port cannot both win.
   */
  async startLogin(): Promise<{ authorize_url: string }> {
    this.cancelLogin()
    const pkce = newPkce()
    const state = newState()
    const listener = await listenForCallback(state, {
      ...(this.options.callbackPort !== undefined ? { port: this.options.callbackPort } : {}),
      ...(this.options.callbackTimeoutMs !== undefined ? { timeoutMs: this.options.callbackTimeoutMs } : {}),
    })
    this.login = { listener, verifier: pkce.verifier, challenge: pkce.challenge }
    return { authorize_url: authorizeUrl(pkce.challenge, state, this.options.endpoint?.issuer) }
  }

  /** Wait for the browser, exchange the code, store the session. */
  async waitLogin(): Promise<ChatGptStatus> {
    const login = this.login
    if (!login) throw new AtomicCoreError('INVALID_ARGUMENT', 'no ChatGPT sign-in is in progress')
    try {
      const code = await login.listener.code
      const tokens = await exchangeCode(
        code,
        { verifier: login.verifier, challenge: login.challenge },
        this.nowUnix(),
        this.options.endpoint
      ).catch((e: AtomicCoreError) => {
        throw e.code === 'AUTH_REQUIRED' ? new AtomicCoreError('AUTH_FAILED', e.message) : e
      })
      await this.set(tokens)
      return await this.status()
    } finally {
      if (this.login === login) this.login = undefined
    }
  }

  cancelLogin(): void {
    const login = this.login
    this.login = undefined
    login?.listener.cancel()
  }
}

function statusOf(tokens: StoredTokens | undefined): ChatGptStatus {
  return tokens
    ? { connected: true, email: tokens.email, plan_type: tokens.plan_type, expires_at: tokens.expires_at }
    : { connected: false, email: null, plan_type: null, expires_at: null }
}
