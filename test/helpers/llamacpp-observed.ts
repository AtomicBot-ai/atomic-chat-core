/**
 * What the live contract probe (`test/live/llamacpp-contract.test.ts`) saw, judged against the
 * contract's `strings` and `routes`. Pure: the probe collects text and answers, these functions say
 * which entries it saw and whether that is what the contract expects. The result is `observed.json`.
 */
import type {
  ContractField,
  ContractRoute,
  ContractString,
  LiveExpectation,
  Severity,
} from './llamacpp-engine-strings.js'

/**
 * `as-expected`; `lost` (expected and not seen: a `severity_if_lost` finding); `appeared` (known
 * drift that is gone: the contract can say `observed` now); `recorded` (conditional or unobservable:
 * seen or not, nothing to judge); `not-checked` (the probe collected nothing on that channel).
 */
export type Verdict = 'as-expected' | 'lost' | 'appeared' | 'recorded' | 'not-checked'

export interface ObservedString {
  id: string
  text: string
  channel: ContractString['channel']
  live_expectation: LiveExpectation
  severity_if_lost: Severity
  seen: boolean | null
  verdict: Verdict
  /** The first line or body that matched, shortened. */
  evidence?: string
}

export interface ObservedField {
  path: string
  when?: ContractField['when']
  live_expectation: LiveExpectation
  severity_if_lost: Severity
  seen: boolean | null
  verdict: Verdict
}

export interface ObservedRoute {
  id: string
  method: ContractRoute['method']
  path: string
  live_expectation: LiveExpectation
  severity_if_lost: Severity
  /** The status the probe got; `null` when it did not ask (a build below `min_build`). */
  status: number | null
  /** Anything but 404/405 means the route exists. */
  seen: boolean | null
  verdict: Verdict
  fields: ObservedField[]
}

export type Captured = Partial<Record<ContractString['channel'], readonly string[]>>

export function matchesString(entry: Pick<ContractString, 'text' | 'match'>, text: string): boolean {
  if (entry.match === 'regex') return new RegExp(entry.text, 'i').test(text)
  return text.toLowerCase().includes(entry.text.toLowerCase())
}

export function verdictOf(expectation: LiveExpectation, seen: boolean | null): Verdict {
  if (seen === null) return 'not-checked'
  if (expectation === 'conditional' || expectation === 'unobservable') return 'recorded'
  if (expectation === 'observed') return seen ? 'as-expected' : 'lost'
  return seen ? 'appeared' : 'as-expected'
}

const shorten = (text: string, max = 300) => (text.length > max ? `${text.slice(0, max)}…` : text)

export function judgeStrings(entries: readonly ContractString[], captured: Captured): ObservedString[] {
  return entries.map((entry) => {
    const texts = captured[entry.channel]
    const hit = texts?.find((t) => matchesString(entry, t))
    const seen = texts === undefined || texts.length === 0 ? null : hit !== undefined
    return {
      id: entry.id,
      text: entry.text,
      channel: entry.channel,
      live_expectation: entry.live_expectation,
      severity_if_lost: entry.severity_if_lost,
      seen,
      verdict: verdictOf(entry.live_expectation, seen),
      ...(hit === undefined ? {} : { evidence: shorten(hit.trim()) }),
    }
  })
}

/** Whether `path` (`a.b`, `a[].b`) reaches a value other than `undefined` in `value`. */
export function hasPath(value: unknown, path: string): boolean {
  const walk = (node: unknown, keys: string[]): boolean => {
    if (keys.length === 0) return node !== undefined
    const [head, ...rest] = keys as [string, ...string[]]
    const array = head.endsWith('[]')
    const key = array ? head.slice(0, -2) : head
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return false
    const child = (node as Record<string, unknown>)[key]
    if (!array) return walk(child, rest)
    return Array.isArray(child) && child.some((item) => walk(item, rest))
  }
  return walk(value, path.split('.'))
}

/** The answers a route gave, by `when`: the plain one, the stream's events, the overflow error. */
export interface RouteAnswers {
  'status'?: number
  'plain'?: unknown
  'stream'?: readonly unknown[]
  'context-overflow'?: unknown
}

/** `build`: the probed build; a field newer than it is not judged. */
export function judgeRoute(
  route: ContractRoute,
  answers: RouteAnswers | undefined,
  build = Number.POSITIVE_INFINITY
): ObservedRoute {
  const status = answers?.status ?? null
  const seen = status === null ? null : status !== 404 && status !== 405
  const fields = (route.fields ?? []).map((f): ObservedField => {
    const answer = f.when === undefined ? answers?.plain : answers?.[f.when]
    const fieldSeen =
      answer === undefined || (f.min_build !== undefined && build < f.min_build)
        ? null
        : f.when === 'stream'
          ? (answer as readonly unknown[]).some((event) => hasPath(event, f.path))
          : hasPath(answer, f.path)
    return {
      path: f.path,
      ...(f.when ? { when: f.when } : {}),
      live_expectation: f.live_expectation,
      severity_if_lost: f.severity_if_lost,
      seen: fieldSeen,
      verdict: verdictOf(f.live_expectation, fieldSeen),
    }
  })
  return {
    id: route.id,
    method: route.method,
    path: route.path,
    live_expectation: route.live_expectation,
    severity_if_lost: route.severity_if_lost,
    status,
    seen,
    verdict: verdictOf(route.live_expectation, seen),
    fields,
  }
}

/** Everything the contract expected and the probe did not see, at `break`. */
export function breaks(strings: readonly ObservedString[], routes: readonly ObservedRoute[]): string[] {
  const lost = (o: { verdict: Verdict; severity_if_lost: Severity }) =>
    o.verdict === 'lost' && o.severity_if_lost === 'break'
  return [
    ...strings.filter(lost).map((s) => `string ${s.id} (${JSON.stringify(s.text)})`),
    ...routes.filter(lost).map((r) => `route ${r.method} ${r.path} (status ${r.status})`),
    ...routes.flatMap((r) =>
      r.fields.filter(lost).map((f) => `field ${r.path} ${f.path}${f.when ? ` (${f.when})` : ''}`)
    ),
  ]
}

/** Everything that is not as the contract says, for the run's log: drift the probe saw. */
export function drift(
  strings: readonly ObservedString[],
  routes: readonly ObservedRoute[]
): Array<{ kind: 'string' | 'route' | 'field'; id: string; verdict: Verdict; severity: Severity }> {
  const off = (v: Verdict) => v === 'lost' || v === 'appeared'
  return [
    ...strings
      .filter((s) => off(s.verdict))
      .map((s) => ({ kind: 'string' as const, id: s.id, verdict: s.verdict, severity: s.severity_if_lost })),
    ...routes
      .filter((r) => off(r.verdict))
      .map((r) => ({ kind: 'route' as const, id: r.id, verdict: r.verdict, severity: r.severity_if_lost })),
    ...routes.flatMap((r) =>
      r.fields
        .filter((f) => off(f.verdict))
        .map((f) => ({
          kind: 'field' as const,
          id: `${r.id}:${f.path}${f.when ? `@${f.when}` : ''}`,
          verdict: f.verdict,
          severity: f.severity_if_lost,
        }))
    ),
  ]
}

/**
 * A llama.cpp log line as a fixture can hold it: without the timestamp the logger puts first
 * (`0.03.573.207 I srv  …`) and with the port the server bound as `<port>`.
 */
export function stableLine(line: string): string {
  return line
    .trim()
    .replace(/^\d+(?:\.\d+){3} /, '')
    .replace(/(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1?\]):\d+/g, '$1:<port>')
}
