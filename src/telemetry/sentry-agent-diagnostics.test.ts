import { describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../contracts/index.js'
import { classifyFailure, diagnosticTags } from './diagnostics.js'

const context = { component: 'http', operation: 'request' } as const

describe('bounded diagnostic tags for sd.cpp install probe failures', () => {
  it('tags sd.cpp install probe failures with finite diagnostic codes', () => {
    const cases = [
      ['The image engine could not load a library it needs.', 'SDCPP_PROBE_LIBRARY_LOAD_FAILED'],
      ['The image engine exited without printing anything.', 'SDCPP_PROBE_SILENT_EXIT'],
      ['The downloaded binary is not stable-diffusion.cpp.', 'SDCPP_PROBE_UNEXPECTED_OUTPUT'],
      ['The image engine did not respond to --help.', 'SDCPP_PROBE_HELP_TIMEOUT'],
      ['The image engine could not be started.', 'SDCPP_PROBE_START_FAILED'],
      ['The archive did not contain sd-server.', 'SDCPP_ARCHIVE_MISSING_SERVER'],
    ] as const

    for (const [message, expectedCode] of cases) {
      const error = new AtomicCoreError(
        'ENGINE_INSTALL_FAILED',
        message,
        '/private/user/sd-cli: dyld: Library not loaded'
      )
      const diagnostic = classifyFailure(error, context)
      const tags = diagnosticTags(error, diagnostic)

      expect(tags).toMatchObject({
        diagnostic_code: expectedCode,
        cause_code: 'ENGINE_INSTALL_FAILED',
        failure_category: 'unknown',
        failure_reason: 'unknown',
      })
      expect(JSON.stringify(tags)).not.toContain('/private')
      expect(JSON.stringify(tags)).not.toContain(message)
    }

    const spawnCause = Object.assign(new Error('spawn /private/user/sd-cli EACCES'), { code: 'EACCES' })
    const startError = new AtomicCoreError(
      'ENGINE_INSTALL_FAILED',
      'The image engine could not be started.',
      '/private/user/sd-cli: spawn EACCES',
      { cause: spawnCause }
    )
    const startTags = diagnosticTags(startError, classifyFailure(startError, context))
    expect(startTags).toMatchObject({
      diagnostic_code: 'SDCPP_PROBE_START_FAILED',
      diagnostic_cause_code: 'EACCES',
    })
    expect(JSON.stringify(startTags)).not.toContain('/private')

    const cycleA = new Error('unmapped wrapper /private/path')
    const cycleB = Object.assign(new Error('The image engine exited without printing anything.'), {
      code: 'PRIVATE_CUSTOM_CODE',
      cause: cycleA,
    })
    cycleA.cause = cycleB
    const cycleTags = diagnosticTags(cycleA, classifyFailure(cycleA, context))
    expect(cycleTags).toMatchObject({
      diagnostic_code: 'SDCPP_PROBE_SILENT_EXIT',
    })
    expect(cycleTags['diagnostic_cause_code']).toBeUndefined()
    expect(JSON.stringify(cycleTags)).not.toContain('PRIVATE_CUSTOM_CODE')
    expect(JSON.stringify(cycleTags)).not.toContain('/private')
  })
})
