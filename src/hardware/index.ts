/**
 * Hardware facts: the core's own probe (shell tools and files, no NVML, no native addon), the
 * app-injectable override that replaces it, and the `HardwareService` that serves both to the
 * control API and to the backend selectors.
 *
 * Ported from: src-tauri/plugins/tauri-plugin-hardware (SystemInfo shape, vendor and CPU-flag
 * spelling); the measurement itself is the core's (ADR 2026-09-27, "the core probes hardware with
 * shell tools"). See PLAN.md §3.2. Public API of this module is exported from this file only.
 */
export * from './facts.js'
export * from './override.js'
export * from './cpu-flags.js'
export * from './nvidia-smi.js'
export * from './drm-sysfs.js'
export * from './windows-video.js'
export * from './vulkan.js'
export * from './merge.js'
export * from './probe-common.js'
export * from './probe.js'
export * from './probe-linux.js'
export * from './probe-windows.js'
export * from './probe-darwin.js'
export * from './service.js'
