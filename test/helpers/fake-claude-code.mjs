// Official-CLI protocol fixture. Never performs network requests or opens a browser.
import { appendFileSync, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
const args = process.argv.slice(2)
const mode = process.env.ATOMIC_FAKE_CLAUDE_MODE
const log = (extra = {}) => {
  if (process.env.ATOMIC_FAKE_CLAUDE_LOG)
    appendFileSync(
      process.env.ATOMIC_FAKE_CLAUDE_LOG,
      JSON.stringify({
        pid: process.pid,
        args,
        hasApiKey: Boolean(process.env.ANTHROPIC_API_KEY),
        hasBaseUrl: Boolean(process.env.ANTHROPIC_BASE_URL),
        ...extra,
      }) + '\n'
    )
}
log()
if (args.includes('--help')) {
  console.log('--safe-mode --input-format --output-format')
  process.exit(0)
}
if (args.includes('--version')) {
  console.log('2.1.281 (fixture)')
  process.exit(0)
}
if (args.includes('auth')) {
  if (args.includes('status')) {
    console.log(
      JSON.stringify({
        loggedIn: mode !== 'logged-out',
        authMethod: mode === 'api' ? 'api_key' : 'claude.ai',
        apiProvider: 'firstParty',
        subscriptionType: 'max',
        email: 'private@example.test',
        secret: 'must-not-leave-status',
      })
    )
    process.exit(mode === 'logged-out' ? 1 : 0)
  }
  if (mode === 'hang-login') setInterval(() => {}, 1000)
  else {
    console.log('private login code must not be forwarded')
    process.exit(0)
  }
} else if (args.includes('--input-format')) {
  createInterface({ input: process.stdin }).once('line', (line) => {
    const request = JSON.parse(line)
    console.log(
      JSON.stringify({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: request.request_id,
          response: {
            models: [
              { value: 'default', resolvedModel: 'claude-opus-5-5[1m]' },
              {
                value: 'claude-fable-5-1[1m]',
                resolvedModel: 'claude-fable-5-1',
                description: 'Fable fixture',
              },
              { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001' },
            ],
          },
        },
      })
    )
  })
} else {
  let text = ''
  for await (const chunk of process.stdin) text += chunk
  const promptIndex = args.indexOf('--system-prompt-file')
  log({ input: text, system: promptIndex < 0 ? null : readFileSync(args[promptIndex + 1], 'utf8') })
  if (mode === 'hang') {
    console.log(
      JSON.stringify({ type: 'stream_event', event: { delta: { type: 'text_delta', text: 'Started' } } })
    )
    setInterval(() => {}, 1000)
  } else if (mode === 'oversize') {
    process.stdout.write('a'.repeat(4 * 1024 * 1024 + 1))
  } else if (mode === 'malformed') {
    console.log('invalid-json')
  } else {
    console.log(
      JSON.stringify({ type: 'stream_event', event: { delta: { type: 'text_delta', text: 'OK' } } })
    )
    console.log(
      JSON.stringify({
        type: 'result',
        subtype: mode === 'error' ? 'error_during_execution' : 'success',
        is_error: mode === 'error',
        errors: mode === 'error' ? ['Usage limit reached'] : undefined,
        session_id: '684286da-7283-4e22-9436-c6f6c3c03015',
        result: 'OK',
        usage: {
          input_tokens: 2,
          cache_read_input_tokens: 10,
          cache_creation_input_tokens: 5,
          output_tokens: 3,
        },
      })
    )
  }
}
