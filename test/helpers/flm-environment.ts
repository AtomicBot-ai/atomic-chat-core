import type { FastFlowLmAccelerators } from '../../src/contracts/index.js'

const sha = 'a'.repeat(64)
export const flmBuild = 'flm-1.0.11-r2'
export const kernel = '6.17.0-1-generic'
const base = {
  revision: 1,
  min_core_version: '0.20.0',
  hardware: { npu_generation: 'xdna2', pci_device_ids: ['1022:17f0'] },
  qualification: {
    build_version: flmBuild,
    evidence: {
      size: 1,
      sha256: sha,
      url: 'https://github.com/AtomicBot-ai/atomic-chat-core/releases/download/' + flmBuild + '/fixture.json',
    },
  },
}
export function linuxManifest() {
  return structuredClone({
    schema_version: 1,
    engine: 'fastflowlm',
    platform: 'linux',
    manifest_id: 'fastflowlm-linux-r1',
    recipes: [
      {
        ...base,
        recipe_id: 'fastflowlm-linux-test',
        action: 'linux.install-amd-npu',
        platforms: [
          { os: 'linux', distribution: 'ubuntu', version: '24.04', arch: 'x64', kernel_release: kernel },
        ],
        sources: [
          {
            id: 'amd',
            url: 'https://ppa.launchpadcontent.net/lemonade-team/stable/ubuntu/',
            suite: 'noble',
            component: 'main',
            signing_fingerprint: '881CF4B40B0BFA288D6776E83BF36CFA0BD50AEC',
          },
        ],
        packages: [
          {
            name: 'amdxdna-dkms',
            version: '7.0.0-rc1+git20260310.6b13cb8f4-noble1',
            architecture: 'amd64',
            source: 'amd',
            path: 'pool/main/a/amdxdna-dkms/amdxdna-dkms_7.0.0-rc1+git20260310.6b13cb8f4-noble1_amd64.deb',
            size: 315696,
            sha256: 'ea9f07d227d91878f3c660dc82b6abe4e4454b0c25d4ffd383920e6bed083893',
          },
        ],
        firmware_version: '1.1.2.64',
        xrt: 'bundled',
        memlock_bytes: 2147483648,
      },
    ],
  })
}
export function windowsManifest() {
  return structuredClone({
    schema_version: 1,
    engine: 'fastflowlm',
    platform: 'windows',
    manifest_id: 'fastflowlm-windows-r1',
    recipes: [
      {
        ...base,
        recipe_id: 'fastflowlm-windows-test',
        action: 'windows.install-amd-npu',
        platforms: [{ os: 'windows', version: '11', arch: 'x64' }],
        driver: {
          version: '32.0.203.314',
          kind: 'windows-update-cab',
          url: 'https://catalog.s.download.windowsupdate.com/c/msdownload/update/driver/drvs/2025/11/bff3a5d0-92a6-4025-b4a6-441222f89117_4c46e3c98d8f4a730543be3f6dac7f8b4ebfa4b7.cab',
          size: 21154403,
          sha256: '31343ae2698e8aa6253981d7571754124baa7d48f0d9b7280ecfa9b75708c33e',
          catalog_sha256: '1449c4e8504f74cae200f9f9a61dff3fd5cf1f217d7b551a5e8c4ebdb3d67aad',
          signer: 'Microsoft Windows Hardware Compatibility Publisher',
        },
      },
    ],
  })
}
export function flmFacts(blockers = ['driver-missing']): FastFlowLmAccelerators {
  return {
    ready: !blockers.length,
    reason: blockers[0] ?? null,
    blockers,
    engine_version: flmBuild,
    runtime_account: 'atomic',
    runtime_mode: 'system-service',
    runtime_service: 'atc.service',
    memlock_bytes: 'unlimited',
    devices: [
      {
        id: '0000:c4:00.1',
        pci_device_id: '1022:17f0',
        pci_revision: '20',
        generation: 'xdna2',
        bdf: '0000:c4:00.1',
        pnp_hardware_id: null,
        driver: blockers.includes('driver-missing') ? 'missing' : 'bound',
        driver_version: blockers.includes('driver-missing') ? null : '0.6',
        firmware: blockers.includes('driver-missing') ? null : '1.1.2.64',
        node: null,
        accessible: blockers.length ? null : true,
        xrt_visible: blockers.length ? null : true,
        ready: !blockers.length,
      },
    ],
    required: {
      driver: 'amdxdna DRM >= 0.6',
      firmware: '>= 1.1',
      memlock_bytes: '2147483648',
      xrt: 'selected engine opens the same PCI device',
    },
    automatic_repair_available: false,
  }
}
