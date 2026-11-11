---
date: 2026-11-11
title: "Isolate managed Foundry CUDA DLLs on Windows"
---

# 2026-11-11 — Isolate managed Foundry CUDA DLLs on Windows

Windows does not specify the order among directories registered with
`AddDllDirectory`. Adding the managed cache and installed Toolkit directories
allowed DLLs with the same basename to compete inside the Foundry host.

Core passes the managed cache path explicitly to the Windows preparation and
CUDA model hosts. With that path set, both Windows architectures limit the DLL
search to the Foundry build, the managed CUDA directory and System32. This
keeps the system NVIDIA driver accessible. The legacy discovery path still
serves hosts without a managed CUDA cache. All loader settings are local to the
child process.

- [Microsoft DLL search order](https://learn.microsoft.com/en-us/windows/win32/dlls/dynamic-link-library-search-order)
