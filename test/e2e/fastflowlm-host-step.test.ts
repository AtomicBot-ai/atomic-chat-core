import wire from '../fixtures/fastflowlm/control-v1.json' with { type: 'json' }
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { BIN } from '../helpers/compiled-core.js'
it('the compiled host helper refuses a substituted Windows NPU package before touching the machine', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'atomic-npu-request-'))
  try {
    const digest = 'sha256:' + 'a'.repeat(64)
    const file = join(directory, 'npu.request.json')
    await writeFile(
      file,
      JSON.stringify({
        schema_version: 1,
        step_id: 'npu',
        operation_id: 'op',
        nonce: 'once',
        expected_operation_revision: 1,
        data_folder: directory,
        recipe_id: 'fastflowlm-windows-test',
        action: 'windows.install-amd-npu',
        recipe_digest: digest,
        parameters_digest: digest,
        parameters: { url: 'https://invalid.example/test.exe' },
      }),
      { mode: 0o600 }
    )
    if (process.platform === 'win32') {
      const secure = String.raw`
 $ErrorActionPreference='Stop'
 $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
 foreach ($p in @($env:STEP_DIR,$env:STEP_FILE)) {
   $a=Get-Acl -LiteralPath $p
   $a.SetSecurityDescriptorSddlForm("O:$($sid)D:P(A;;FA;;;$($sid))(A;;FA;;;SY)(A;;FA;;;BA)")
   Set-Acl -LiteralPath $p -AclObject $a
 }
 `
      const acl = spawnSync(
        join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-Command', secure],
        {
          env: {
            SystemRoot: process.env.SystemRoot,
            PATH: join(process.env.SystemRoot!, 'System32'),
            TEMP: tmpdir(),
            TMP: tmpdir(),
            // Hosted runners start in PowerShell 7; Windows PowerShell must load its own modules.
            PSModulePath: join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'),
            STEP_DIR: directory,
            STEP_FILE: file,
          },
          encoding: 'utf8',
        }
      )
      if (acl.status !== 0) throw Error(acl.stderr)
    }

    const launchDigest = createHash('sha256')
      .update(await readFile(file))
      .digest('hex')
    const run = spawnSync(BIN, ['host-step', 'exec', file, '--request-sha256', launchDigest, '--json'], {
      encoding: 'utf8',
      env: { ...process.env, SUDO_UID: String(process.getuid?.() ?? 0) },
    })
    expect(run.status, run.stderr).toBe(1)
    const result = JSON.parse(await readFile(join(directory, 'npu.result.json'), 'utf8'))
    expect(result).toMatchObject({
      step_id: 'npu',
      nonce: 'once',
      outcome: 'failed',
      error_code: 'MANAGED_HOST_STEP_INVALID',
      steps: [],
    })
    expect(result.log_tail).toContain('Unsupported Windows NPU')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it.skipIf(process.platform === 'win32')(
  'the compiled Linux NPU helper refuses a different request before package or account operations',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atomic-npu-linux-'))
    try {
      const step = wire.operation.pending_host_step,
        file = join(dir, step.step_id + '.request.json')
      const text = JSON.stringify({ ...step, schema_version: 1, operation_id: 'op', data_folder: dir })
      const digest = createHash('sha256').update(text).digest('hex')
      await writeFile(file, text + ' ', { mode: 0o600 })
      const run = spawnSync(BIN, ['host-step', 'exec', file, '--request-sha256', digest, '--json'], {
        encoding: 'utf8',
        env: { ...process.env, SUDO_UID: String(process.getuid?.() ?? 0) },
      })
      expect(run.status, run.stderr).toBe(1)
      expect(JSON.parse(run.stdout)).toMatchObject({
        steps: [],
        error_code: 'MANAGED_HOST_STEP_INVALID',
        log_tail: expect.stringContaining('launch digest'),
      })
    } finally {
      await rm(dir, { force: true, recursive: true })
    }
  }
)
