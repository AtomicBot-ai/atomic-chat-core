/**
 * `backends list|recommend|updates` — the advisor's three answers for a llama.cpp provider, so what
 * the desktop app shows can be seen (and scripted) without it.
 */

import { parseArgs } from 'node:util'
import type {
  BackendCatalogResponse,
  BackendRecommendationResponse,
  BackendUpdateCheckResponse,
  LlamacppProviderId,
} from '../../contracts/index.js'
import { isLlamacppProviderId } from '../../backend/index.js'
import { withAttachedOwner } from '../owner.js'
import type { CliIo } from '../io.js'
import { attachOptions } from './hardware.js'
import { layoutFor } from './shared.js'

const SUBCOMMANDS = ['list', 'recommend', 'updates'] as const

export async function backendsCommand(argv: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      'json': { type: 'boolean' },
      'provider': { type: 'string' },
      'current': { type: 'string' },
      'force': { type: 'boolean' },
      'mode': { type: 'string' },
      'app-version': { type: 'string' },
      'data-folder': { type: 'string' },
    },
    allowPositionals: true,
    strict: true,
  })
  const sub = positionals[0] ?? 'list'
  if (!(SUBCOMMANDS as readonly string[]).includes(sub)) {
    io.stderr(`Unknown backends subcommand: ${sub} (use ${SUBCOMMANDS.join(', ')})\n`)
    return 2
  }
  const provider = values.provider ?? 'llamacpp-upstream'
  if (!isLlamacppProviderId(provider)) {
    io.stderr(`--provider must be llamacpp-upstream or llamacpp, not ${provider}\n`)
    return 2
  }
  const mode = values.mode ?? 'recheck'
  if (sub === 'recommend' && mode !== 'refresh' && mode !== 'recheck') {
    io.stderr(`--mode must be refresh or recheck, not ${mode}\n`)
    return 2
  }
  const common = {
    ...(values.force ? { force: true } : {}),
    ...(values['app-version'] ? { app_version: values['app-version'] } : {}),
  }
  const layout = layoutFor(values, io)
  const result = await withAttachedOwner(attachOptions(layout, `backends ${sub}`, io), async ({ client }) => {
    if (sub === 'list')
      return client.backendCatalog(provider, {
        ...common,
        ...(values.current ? { current_backend: values.current } : {}),
      })
    if (sub === 'recommend')
      return client.recommendBackend(provider, {
        mode: mode as 'refresh' | 'recheck',
        ...common,
        ...(values.current ? { current_backend: values.current } : {}),
      })
    return client.checkBackendUpdates(provider, {
      ...common,
      ...(values.current ? { current: values.current } : {}),
    })
  })
  if (values.json) {
    io.stdout(`${JSON.stringify(result, null, 2)}\n`)
    return 0
  }
  if (sub === 'list') io.stdout(formatCatalog(result as BackendCatalogResponse, values.current))
  else if (sub === 'recommend') io.stdout(formatRecommendation(result as BackendRecommendationResponse))
  else io.stdout(formatUpdates(result as BackendUpdateCheckResponse))
  return 0
}

export function formatCatalog(catalog: BackendCatalogResponse, current?: string): string {
  const lines: string[] = ['']
  const installed = new Set(catalog.installed.map((entry) => `${entry.version}/${entry.backend}`))
  if (catalog.available.length === 0) {
    lines.push(
      `  No backend of ${catalog.provider as LlamacppProviderId} fits this machine (source: ${catalog.source}).`
    )
  } else {
    const width = Math.max(7, ...catalog.available.map((entry) => entry.version.length))
    lines.push(`  ${'VERSION'.padEnd(width)}  ${'BACKEND'.padEnd(24)}  INSTALLED  MARKS`)
    for (const entry of catalog.available) {
      const id = `${entry.version}/${entry.backend}`
      const marks: string[] = []
      if (id === catalog.recommended) marks.push('recommended')
      if (current && id === current) marks.push('current')
      lines.push(
        `  ${entry.version.padEnd(width)}  ${entry.backend.padEnd(24)}  ${(installed.has(id) ? 'yes' : '-').padEnd(9)}  ${marks.join(', ')}`
      )
    }
  }
  lines.push('')
  lines.push(`  Supported   ${catalog.supported_backends.join(', ') || 'none'}`)
  lines.push(`  Recommended ${catalog.recommended ?? 'none'}`)
  lines.push(`  Source      ${catalog.source} (hardware: ${catalog.hardware_source})`)
  lines.push('')
  return `${lines.join('\n')}\n`
}

export function formatRecommendation(result: BackendRecommendationResponse): string {
  const lines: string[] = ['']
  switch (result.outcome) {
    case 'mac':
      lines.push('  macOS runs its single Metal build; nothing to recommend.')
      break
    case 'detection_failed':
      lines.push('  Detection could not complete; keeping the current backend.')
      break
    case 'cpu_optimal':
      lines.push('  The CPU build is the best this machine can run.')
      break
    case 'already_optimal':
      lines.push(
        `  Already on the recommended backend${result.record ? ` (${result.record.currentBackend})` : ''}.`
      )
      break
    case 'no_catalog_entry':
      lines.push('  A better backend type exists but no release of it is published; keeping the current one.')
      break
    case 'recommend':
      lines.push(
        `  Recommended ${result.recommendation?.recommendedBackend ?? '?'} (${result.recommendation?.recommendedCategory ?? '?'})`
      )
      lines.push(`  Current     ${result.recommendation?.currentBackend || 'none'}`)
      break
  }
  lines.push(
    `  Detection   ${result.detection ? result.detection.kind : 'skipped'}, ${result.mode}, ${result.elapsed_ms} ms`
  )
  lines.push(`  Record      revision ${result.revision}`)
  lines.push('')
  return `${lines.join('\n')}\n`
}

export function formatUpdates(result: BackendUpdateCheckResponse): string {
  const lines: string[] = ['']
  if (result.current_kind === 'missing') lines.push('  No backend is configured for this provider.')
  else if (!result.update_needed) lines.push(`  Up to date: ${result.current}`)
  else if (result.same_family)
    lines.push(`  Update: ${result.current} -> ${result.target_backend ?? '?'} (same family)`)
  else
    lines.push(
      `  Newer build ${result.target_backend ?? '?'} is a different family than ${result.current}; not offered automatically.`
    )
  lines.push('')
  return `${lines.join('\n')}\n`
}
