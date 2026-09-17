/**
 * `providers` and `auth`: the cloud side of the core from a terminal — register a provider the
 * Local API Server should route to, and connect a ChatGPT subscription (PLAN.md §3.2 `cli/`).
 *
 * Both talk to the core that owns the data folder, starting it when none is running, so the same
 * store the app sees is the one changed. Keys can come from an environment variable instead of the
 * command line, where they would end up in shell history.
 */

import { parseArgs } from 'node:util'
import { AtomicCoreError } from '../contracts/index.js'
import type { CloudProviderView } from '../cloud/index.js'
import type { CoreClient } from '../client/index.js'
import { layoutFor } from './commands/index.js'
import type { CliIo } from './io.js'
import { withAttachedOwner } from './owner.js'

function withOwner<T>(
  values: Record<string, unknown>,
  io: CliIo,
  name: string,
  work: (client: CoreClient) => Promise<T>
): Promise<T> {
  return withAttachedOwner(
    {
      layout: layoutFor(values, io),
      clientName: `atomic-chat-core ${name}`,
      launch: true,
      log: (message) => io.stderr(`${message}\n`),
    },
    ({ client }) => work(client)
  )
}

function parseHeader(raw: string): { header: string; value: string } {
  const colon = raw.indexOf(':')
  if (colon <= 0)
    throw new AtomicCoreError('INVALID_ARGUMENT', `--header must look like "Name: value", got "${raw}"`)
  return { header: raw.slice(0, colon).trim(), value: raw.slice(colon + 1).trim() }
}

function describeProvider(p: CloudProviderView): string {
  const key = p.has_api_key ? 'key set' : 'no key'
  return `  ${p.provider}  ${p.base_url ?? '(no base URL)'}  ${key}  ${p.models.length} model(s)\n`
}

/** `providers list | set <name> | remove <name>` */
export async function providersCommand(argv: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      'data-folder': { type: 'string' },
      'json': { type: 'boolean' },
      'base-url': { type: 'string' },
      'api-key': { type: 'string' },
      'api-key-env': { type: 'string' },
      'clear-api-key': { type: 'boolean' },
      'model': { type: 'string', multiple: true },
      'header': { type: 'string', multiple: true },
    },
    allowPositionals: true,
    strict: true,
  })
  const [action, name] = positionals
  switch (action) {
    case 'list': {
      const { providers } = await withOwner(values, io, 'providers', (client) => client.cloudProviders())
      if (values.json) io.stdout(`${JSON.stringify(providers, null, 2)}\n`)
      else if (providers.length === 0) io.stdout('No cloud providers are registered.\n')
      else for (const p of providers) io.stdout(describeProvider(p))
      return 0
    }
    case 'set': {
      if (!name) throw new AtomicCoreError('INVALID_ARGUMENT', 'providers set needs a provider name')
      let apiKey: string | null | undefined
      if (values['clear-api-key']) apiKey = null
      else if (values['api-key-env']) {
        apiKey = io.env[values['api-key-env']]
        if (!apiKey)
          throw new AtomicCoreError(
            'INVALID_ARGUMENT',
            `environment variable ${values['api-key-env']} is empty`
          )
      } else if (values['api-key'] !== undefined) apiKey = values['api-key']
      const view = await withOwner(values, io, 'providers', (client) =>
        client.setCloudProvider(name, {
          ...(apiKey !== undefined ? { api_key: apiKey } : {}),
          ...(values['base-url'] !== undefined ? { base_url: values['base-url'] } : {}),
          models: values.model ?? [],
          custom_headers: (values.header ?? []).map(parseHeader),
        })
      )
      if (values.json) io.stdout(`${JSON.stringify(view, null, 2)}\n`)
      else io.stdout(`Registered ${view.provider}.\n${describeProvider(view)}`)
      return 0
    }
    case 'remove': {
      if (!name) throw new AtomicCoreError('INVALID_ARGUMENT', 'providers remove needs a provider name')
      await withOwner(values, io, 'providers', (client) => client.removeCloudProvider(name))
      io.stdout(`Removed ${name}.\n`)
      return 0
    }
    default:
      io.stderr('Usage: atomic-chat-core providers list | set <name> [options] | remove <name>\n')
      return 2
  }
}

/** `auth chatgpt status | login | logout | models` */
export async function authCommand(argv: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      'data-folder': { type: 'string' },
      'json': { type: 'boolean' },
      'no-browser': { type: 'boolean' },
    },
    allowPositionals: true,
    strict: true,
  })
  const [service, action] = positionals
  if (service !== 'chatgpt' || !['status', 'login', 'logout', 'models'].includes(action ?? '')) {
    io.stderr('Usage: atomic-chat-core auth chatgpt status | login | logout | models\n')
    return 2
  }
  const print = (value: unknown, text: string) =>
    io.stdout(values.json ? `${JSON.stringify(value, null, 2)}\n` : text)

  return withOwner(values, io, 'auth', async (client) => {
    switch (action) {
      case 'status': {
        const status = await client.chatgptStatus()
        print(
          status,
          status.connected
            ? `Connected as ${status.email ?? 'unknown'} (${status.plan_type ?? 'plan unknown'}).\n`
            : 'Not connected.\n'
        )
        return status.connected ? 0 : 1
      }
      case 'login': {
        const { authorize_url } = await client.chatgptStartLogin()
        io.stderr(`Sign in to ChatGPT in your browser:\n\n  ${authorize_url}\n\n`)
        if (!values['no-browser']) await io.openUrl(authorize_url)
        const status = await client.chatgptWaitLogin()
        print(status, `Connected as ${status.email ?? 'unknown'} (${status.plan_type ?? 'plan unknown'}).\n`)
        return 0
      }
      case 'logout': {
        print(await client.chatgptLogout(), 'Disconnected.\n')
        return 0
      }
      default: {
        const { models } = await client.chatgptModels()
        print(
          models,
          models.map((m) => `  ${m.id}${m.listed ? '' : '  (hidden)'}\n`).join('') || 'No models.\n'
        )
        return 0
      }
    }
  })
}
