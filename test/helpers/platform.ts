/**
 * Tests that describe a POSIX host — the Linux Docker desktop, the Linux root executor, a fake binary
 * that is a shebang script — and have no meaning on a Windows runner, where the core works through its
 * WSL guest instead (the Windows tests cover that). Called first in a describe body or a test, not as
 * `describe.skipIf(...)` at the call: prettier keeps a plain `describe(name, fn)` on one line however
 * long the name, and anything else re-indents the whole block.
 */
import { beforeEach } from 'vitest'
import type { TestContext } from 'vitest'

/** Every test of the enclosing describe is skipped on Windows, for `reason`. */
export function skipOnWindows(reason: string): void {
  beforeEach((ctx) => {
    if (process.platform === 'win32') ctx.skip(reason)
  })
}

/** This test is skipped on Windows, for `reason`. */
export function skipTestOnWindows(ctx: TestContext, reason: string): void {
  if (process.platform === 'win32') ctx.skip(reason)
}
