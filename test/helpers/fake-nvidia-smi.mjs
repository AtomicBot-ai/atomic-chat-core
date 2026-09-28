#!/usr/bin/env node
/**
 * A stand-in for `nvidia-smi --query-gpu=… --format=csv,noheader,nounits`, for the hardware e2e on
 * Linux: one RTX 4090 with the driver 581.42. Wrapped by a `#!/bin/sh` script named `nvidia-smi` in
 * a directory the test prepends to PATH.
 *
 *   FAKE_NVIDIA_SMI_MODE  modern (default) | legacy — `legacy` refuses `compute_cap` the way a
 *                         driver older than 470 does, so the probe has to retry with the legacy fields.
 */
const mode = process.env.FAKE_NVIDIA_SMI_MODE ?? 'modern'
const query = process.argv.find((arg) => arg.startsWith('--query-gpu='))
if (!query) {
  process.stderr.write('fake-nvidia-smi: only --query-gpu is supported\n')
  process.exit(2)
}
const fields = query.slice('--query-gpu='.length).split(',')
if (mode === 'legacy' && fields.includes('compute_cap')) {
  process.stderr.write(
    'Field "compute_cap" is not a valid field to query.\n\nPlease run \'nvidia-smi --help-query-gpu\' for a list of available fields.\n'
  )
  process.exit(2)
}
const values = {
  'index': '0',
  'name': 'NVIDIA GeForce RTX 4090',
  'uuid': 'GPU-0b6f4f4e-6c1c-3a54-8f2d-1b0d2f4d6a11',
  'memory.total': '24564',
  'driver_version': '581.42',
  'compute_cap': '8.9',
  'pci.bus_id': '00000000:01:00.0',
}
const unknown = fields.filter((field) => !(field in values))
if (unknown.length) {
  process.stderr.write(`Field "${unknown[0]}" is not a valid field to query.\n`)
  process.exit(2)
}
process.stdout.write(fields.map((field) => values[field]).join(', ') + '\n')
