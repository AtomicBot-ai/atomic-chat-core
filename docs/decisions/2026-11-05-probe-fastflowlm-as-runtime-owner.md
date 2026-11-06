---
date: 2026-11-05
title: Probe the selected FastFlowLM build as the runtime owner
---

# Probe the selected FastFlowLM build as the runtime owner

Presence comes from PCI sysfs or present Windows PnP instances. For this release the XDNA2 allowlist covers 1022:17f0 revisions 10, 11 and 20. An unbound device retains its identity. The [Linux driver device table](https://github.com/torvalds/linux/blob/master/drivers/accel/amdxdna/amdxdna_pci_drv.c) lists the device/revision pairs.

The owner runs two bounded subprocesses of the installed build. Atomic revision 2 advertises environment probe protocol 1. Its validation entry point bypasses model discovery and disables the upstream attempt to raise the soft memlock limit. The second command opens device zero through the engine's XRT and reads its PCI identity. Linux matches the bus address. Windows matches vendor, device, revision, subsystem vendor and subsystem device against the unique present target. On the physical Windows host the XRT handle and PnP agreed on all five fields but encoded the bus address differently. Serial probes keep DRM and XRT handles separate. Linux uses the packaged executable and library mirror directly because the upstream launcher can repair missing mirror entries. Missing evidence, elevated credentials or a different device identity blocks readiness. Older builds still install and report their identity.

The initial Linux policy uses the 2 GiB soft limit from the accepted Qwen3 run. That run requested 1084 MiB, above the 100 MiB minimum checked by upstream validation. This conservative threshold may exclude working configurations with lower limits. Future model loads still need their own allocation checks.

Each request measures the account, service and limits of the owner again. Readiness expires when the account, active build, device or service context changes. Installation, service configuration and repair require separate preparation recipes and consent.
