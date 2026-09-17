/**
 * The argv mlx-server is started with.
 *
 * Ported from: tauri-plugin-mlx/src/commands.rs (`build_mlx_server_args`, `normalize_mlx_model_path`).
 * Contract: test/fixtures/app/mlx-args.
 */

import { statSync } from 'node:fs'
import { dirname } from 'node:path'
import type { MlxServerConfig } from './config.js'

/** A weight *file* stands for its model folder; anything else (a folder, a missing path) is kept. */
export function normalizeMlxModelPath(
  path: string,
  isFile: (path: string) => boolean = isRegularFile
): string {
  return isFile(path) ? dirname(path) : path
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

const DRAFT_KINDS = new Set(['dflash', 'mtp', 'eagle3'])

export function buildMlxServerArgs(
  modelPath: string,
  port: number,
  config: MlxServerConfig,
  isFile?: (path: string) => boolean
): string[] {
  const args = [
    '--model',
    normalizeMlxModelPath(modelPath, isFile),
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
  ]
  if (config.ctx_size > 0) args.push('--max-kv-size', String(config.ctx_size))
  if (config.draft_model_path !== '') {
    args.push('--draft-model', normalizeMlxModelPath(config.draft_model_path, isFile))
    args.push('--draft-kind', DRAFT_KINDS.has(config.draft_kind) ? config.draft_kind : 'dflash')
    if (config.block_size > 0) args.push('--draft-block-size', String(config.block_size))
  }
  if ((config.kv_quant_scheme === 'uniform' || config.kv_quant_scheme === 'turboquant') && config.kv_bits > 0)
    // Rust formats the f32 without a trailing ".0"; so does String for the values settings allow.
    args.push('--kv-bits', String(config.kv_bits), '--kv-quant-scheme', config.kv_quant_scheme)
  return args
}
