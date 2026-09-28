/** `hardware info` — the machine as the core sees it, which is what backend selection runs on. */

import { parseArgs } from 'node:util'
import type { HardwareInfoResponse } from '../../contracts/index.js'
import type { DataLayout } from '../../config/index.js'
import { withAttachedOwner } from '../owner.js'
import type { CliIo } from '../io.js'
import { layoutFor } from './shared.js'

export async function hardwareCommand(argv: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      'json': { type: 'boolean' },
      'refresh': { type: 'boolean' },
      'data-folder': { type: 'string' },
    },
    allowPositionals: true,
    strict: true,
  })
  const sub = positionals[0] ?? 'info'
  if (sub !== 'info') {
    io.stderr(`Unknown hardware subcommand: ${sub}\n`)
    return 2
  }
  const layout = layoutFor(values, io)
  const info = await withAttachedOwner(attachOptions(layout, 'hardware info', io), ({ client }) =>
    values.refresh ? client.refreshHardware() : client.hardwareInfo()
  )
  if (values.json) {
    io.stdout(`${JSON.stringify(info, null, 2)}\n`)
    return 0
  }
  io.stdout(formatHardwareInfo(info))
  return 0
}

/** The owner to ask: start one when none runs — the answer is the core's own probe. */
export function attachOptions(layout: DataLayout, command: string, io: CliIo) {
  return {
    layout,
    clientName: `atomic-chat-core ${command}`,
    launch: true,
    log: (message: string) => io.stderr(`${message}\n`),
  }
}

export function formatHardwareInfo(response: HardwareInfoResponse): string {
  const { info } = response
  const lines: string[] = []
  lines.push('')
  lines.push(`  OS        ${info.os_name || info.os_type} (${info.os_type})`)
  lines.push(`  CPU       ${info.cpu.name}, ${info.cpu.core_count} cores, ${info.cpu.arch}`)
  const flags = info.cpu.extensions_known
    ? info.cpu.extensions.filter((flag) => /^avx/.test(flag)).join(', ') || 'no AVX'
    : 'unknown'
  lines.push(`  Flags     ${flags}`)
  lines.push(`  Memory    ${formatMiB(info.total_memory)}`)
  if (info.gpus.length === 0) lines.push('  GPU       none detected')
  for (const gpu of info.gpus) {
    const parts = [gpu.vendor, gpu.name, formatMiB(gpu.total_memory)]
    if (gpu.driver_version) parts.push(`driver ${gpu.driver_version}`)
    if (gpu.nvidia_info?.compute_capability) parts.push(`cc ${gpu.nvidia_info.compute_capability}`)
    if (gpu.vulkan_info) parts.push(`vulkan ${gpu.vulkan_info.device_type}`)
    lines.push(`  GPU       ${parts.join(', ')}`)
  }
  lines.push(`  Source    ${response.source} at ${new Date(response.probed_at).toISOString()}`)
  for (const warning of response.warnings) lines.push(`  Warning   ${warning}`)
  lines.push('')
  return `${lines.join('\n')}\n`
}

function formatMiB(mib: number): string {
  return mib >= 1024 ? `${(mib / 1024).toFixed(1)} GiB` : `${mib} MiB`
}
