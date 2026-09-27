# Hardware probe fixtures

Recorded (or, where marked, hand-written) tool output for the parsers in `src/hardware/`. Each parser
test reads these through `test/helpers/hardware-fixtures.ts`. Keep a file's origin here when adding one.

| File | Source | Synthetic? |
| --- | --- | --- |
| `proc-cpuinfo-ryzen-7950x.txt` | `/proc/cpuinfo` of an AMD Ryzen 9 7950X, Linux 6.8, cut to four processors (core ids 0, 1, 2, 0 on purpose) | trimmed; flags lists of processors 1–3 shortened |
| `proc-cpuinfo-graviton-arm64.txt` | `/proc/cpuinfo` of an AWS Graviton3 (Neoverse-V1), two processors | trimmed |
| `proc-cpuinfo-core2-q9550.txt` | `/proc/cpuinfo` of an Intel Core 2 Quad Q9550 (no AVX), one processor | trimmed |
| `nvidia-smi-rtx4090-rtx3060-modern.csv` | `nvidia-smi --query-gpu=index,name,uuid,memory.total,driver_version,compute_cap,pci.bus_id --format=csv,noheader,nounits`, driver 581.42, two cards | yes: uuids invented |
| `nvidia-smi-gtx1080-legacy.csv` | the same query without `compute_cap`, driver 460.91.03 | yes: uuid invented |
| `nvidia-smi-rtx4090-na.csv` | the modern query where `compute_cap` and `pci.bus_id` answer `[N/A]` | yes |
| `nvidia-smi-unknown-field.stderr.txt` | stderr of a pre-470 driver asked for `compute_cap` | wording as the tool prints it |
| `vulkaninfo-summary-linux-rtx4090-intel-llvmpipe.txt` | `vulkaninfo --summary`, Ubuntu 24.04, NVIDIA 550 + Mesa 24.0.9 (Intel iGPU + llvmpipe) | header sections shortened; UUIDs invented |
| `vulkaninfo-summary-linux-rx7900xtx.txt` | `vulkaninfo --summary`, Arch, Mesa 24.2.8 RADV on an RX 7900 XTX | header shortened |
| `windows-probe-hybrid-rtx4090-uhd770.json` | the `WINDOWS_PROBE_SCRIPT` document on Windows 11 24H2 with an RTX 4090 and an Intel UHD 770, PowerShell 7 array shape | **synthetic** — composed from documented CIM/registry shapes, not recorded |
| `windows-probe-rx7900xtx-ps51.json` | the same script on Windows 10 22H2 with an RX 7900 XTX, PowerShell 5.1 single-element collapse, with a UTF-8 BOM | **synthetic** |
| `windows-probe-no-gpu-server2022.json` | the same script on a headless Windows Server 2022 VM (`Add-Type` failed) | **synthetic** |

The Windows documents are synthetic until real ones are recorded (open risk in the 2026-09-27 hardware
ADR); replace them with recorded output when a Windows machine is at hand and keep the shapes they
exercise (single-element collapse, BOM, `null` fields, software adapters).
