// Reviewed PCI device ID -> gfx target for all 20 architectures compiled into the
// llama.cpp b12019 Windows ROCm archive (RDNA 1-4, including APUs).
// Sources reviewed 2026-11-07:
// https://github.com/ggml-org/llama.cpp/blob/b12019/.github/workflows/release.yml
// https://pci-ids.ucw.cz/v2.2/pci.ids (AMD 1002 GPU functions, grouped by silicon)
// https://llvm.org/docs/AMDGPUUsage.html#processors
// https://rocm.docs.amd.com/en/docs-10.1.0/reference/gpu-specs.html
// https://github.com/ROCm/TheRock/blob/main/SUPPORTED_GPUS.md
//
// This gates compiled architecture eligibility, not a promise about the installed
// driver. Installed HIP packs must enumerate a ROCm device; otherwise prefer Vulkan.
// Unknown IDs and architectures absent from the archive remain excluded. Match full
// silicon names, not marketing substrings (Navi10Lite is not Navi 10); exclude USB,
// audio and bridge functions. Reconcile all these sources when refreshing the table.
export const AMD_ROCM_WINDOWS_PCI_IDS: ReadonlyArray<readonly [number, string]> = [
  [0x1114, 'gfx1152'], // Krackan [Radeon 840M / 860M Graphics]
  [0x1435, 'gfx1033'], // Sephiroth [AMD Custom GPU 0405]
  [0x1506, 'gfx1036'], // Mendocino [Radeon 610M]
  [0x150e, 'gfx1150'], // Strix [Radeon 880M / 890M]
  [0x1586, 'gfx1151'], // Strix Halo [Radeon Graphics / Radeon 8050S Graphics / Radeon 8060S Graphics]
  [0x15bf, 'gfx1103'], // Phoenix1 [Radeon 740M / 760M / 780M Graphics]
  [0x15c8, 'gfx1103'], // Phoenix2 [Radeon 740M Graphics]
  [0x163f, 'gfx1033'], // VanGogh [AMD Custom GPU 0405]
  [0x164d, 'gfx1035'], // Rembrandt
  [0x164e, 'gfx1036'], // Raphael [Radeon 610M]
  [0x164f, 'gfx1103'], // Phoenix
  [0x1681, 'gfx1035'], // Rembrandt [Radeon 660M / 680M]
  [0x1902, 'gfx1153'], // Krackan2 [Radeon 820M / 840M Graphics]
  [0x7310, 'gfx1010'], // Navi 10 [Radeon Pro W5700X]
  [0x7312, 'gfx1010'], // Navi 10 [Radeon Pro W5700]
  [0x7319, 'gfx1010'], // Navi 10 [Radeon Pro 5700 XT]
  [0x731b, 'gfx1010'], // Navi 10 [Radeon Pro 5700]
  [0x731f, 'gfx1010'], // Navi 10 [Radeon RX 5600 OEM/5600 XT / 5700/5700 XT]
  [0x7340, 'gfx1012'], // Navi 14 [Radeon RX 5500/5500M / Pro 5300/5300M/5500M]
  [0x7341, 'gfx1012'], // Navi 14 [Radeon Pro W5500]
  [0x7347, 'gfx1012'], // Navi 14 [Radeon Pro W5500M]
  [0x734f, 'gfx1012'], // Navi 14 [Radeon Pro W5300M]
  [0x7360, 'gfx1011'], // Navi 12 [Radeon Pro 5600M/V520/BC-160]
  [0x7362, 'gfx1011'], // Navi 12 [Radeon Pro V520/V540]
  [0x73a1, 'gfx1030'], // Navi 21 [Radeon Pro V620]
  [0x73a2, 'gfx1030'], // Navi 21 Pro-XTA [Radeon Pro W6900X]
  [0x73a3, 'gfx1030'], // Navi 21 GL-XL [Radeon PRO W6800]
  [0x73a5, 'gfx1030'], // Navi 21 [Radeon RX 6950 XT]
  [0x73ab, 'gfx1030'], // Navi 21 Pro-XLA [Radeon Pro W6800X/Radeon Pro W6800X Duo]
  [0x73ae, 'gfx1030'], // Navi 21 [Radeon Pro V620 MxGPU]
  [0x73af, 'gfx1030'], // Navi 21 [Radeon RX 6900 XT]
  [0x73bf, 'gfx1030'], // Navi 21 [Radeon RX 6800/6800 XT / 6900 XT]
  [0x73c3, 'gfx1031'], // Navi 22
  [0x73ce, 'gfx1031'], // Navi 22-XL SRIOV MxGPU
  [0x73df, 'gfx1031'], // Navi 22 [Radeon RX 6700/6700 XT/6750 XT / 6800M/6850M XT]
  [0x73e0, 'gfx1032'], // Navi 23
  [0x73e1, 'gfx1032'], // Navi 23 WKS-XM [Radeon PRO W6600M]
  [0x73e3, 'gfx1032'], // Navi 23 WKS-XL [Radeon PRO W6600]
  [0x73ef, 'gfx1032'], // Navi 23 [Radeon RX 6650 XT / 6700S / 6800S]
  [0x73f0, 'gfx1102'], // Navi 33 [Radeon RX 7600M XT]
  [0x73ff, 'gfx1032'], // Navi 23 [Radeon RX 6600/6600 XT/6600M]
  [0x7421, 'gfx1034'], // Navi 24 [Radeon PRO W6500M]
  [0x7422, 'gfx1034'], // Navi 24 [Radeon PRO W6400]
  [0x7423, 'gfx1034'], // Navi 24 [Radeon PRO W6300/W6300M]
  [0x7424, 'gfx1034'], // Navi 24 [Radeon RX 6300]
  [0x743f, 'gfx1034'], // Navi 24 [Radeon RX 6400/6500 XT/6500M]
  [0x7448, 'gfx1100'], // Navi 31 [Radeon Pro W7900]
  [0x7449, 'gfx1100'], // Navi 31 [Radeon Pro W7800 48GB]
  [0x744a, 'gfx1100'], // Navi 31 [Radeon Pro W7900 Dual Slot]
  [0x744b, 'gfx1100'], // Navi 31 [Radeon Pro W7900D]
  [0x744c, 'gfx1100'], // Navi 31 [Radeon RX 7900 XT/7900 XTX/7900 GRE/7900M]
  [0x745e, 'gfx1100'], // Navi 31 [Radeon Pro W7800]
  [0x7460, 'gfx1101'], // Navi 32 GL-XL [AMD Radeon PRO V710]
  [0x7461, 'gfx1101'], // Navi 32 [AMD Radeon PRO V710]
  [0x7470, 'gfx1101'], // Navi 32 [Radeon PRO W7700]
  [0x747e, 'gfx1101'], // Navi 32 [Radeon RX 7700 XT / 7800 XT]
  [0x7480, 'gfx1102'], // Navi 33 [Radeon RX 7600/7600 XT/7600M XT/7600S/7700S / PRO W7600]
  [0x7481, 'gfx1102'], // Navi 33 [Steam Machine]
  [0x7483, 'gfx1102'], // Navi 33 [Radeon RX 7600M/7600M XT]
  [0x7487, 'gfx1102'], // Navi 33 [Radeon Graphics]
  [0x7489, 'gfx1102'], // Navi 33 [Radeon Pro W7500]
  [0x748b, 'gfx1102'], // Navi 33 [Radeon Graphics]
  [0x7499, 'gfx1102'], // Navi 33 [Radeon RX 7400/7300/Pro W7400]
  [0x749f, 'gfx1102'], // Navi 33 [Radeon RX 7500]
  [0x7550, 'gfx1201'], // Navi 48 [Radeon RX 9070/9070 XT/9070 GRE]
  [0x7551, 'gfx1201'], // Navi 48 [Radeon AI PRO R9700]
  [0x7590, 'gfx1200'], // Navi 44 [Radeon RX 9050 / 9060 XT]
]

/** True when the reviewed PCI ID maps to a target in the upstream Windows HIP archive. */
export function isRocmSupportedPciId(deviceId: number): boolean {
  return AMD_ROCM_WINDOWS_PCI_IDS.some(([supported]) => supported === deviceId)
}
