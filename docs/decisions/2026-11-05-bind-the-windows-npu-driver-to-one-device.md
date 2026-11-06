---
date: 2026-11-05
title: Bind the pinned AMD NPU driver to one Windows device instance
---

# Bind the pinned AMD NPU driver to one Windows device instance

The Windows helper accepts one Microsoft Update Catalog CAB, update 7193bd4f-927d-44fd-ae77-c1e4ba75be1f, AMD version 32.0.203.314. Core pins its URL, size, SHA-256, INF hash, catalog hash and publisher. A newly published package needs a matching core change as well as a qualified configuration. The production bootstrap has no recipes. The staging candidate establishes package identity; it cannot by itself qualify a Windows installation.

The trusted launcher binds the complete serialized request to its elevated arguments with SHA-256. A user-writable request alone could otherwise substitute another device during UAC and recompute its own digests. The helper locates Windows tools through the kernel SystemRoot link, including its first ACL check. It verifies the consent parameters, manifest and recipe digests and checks the present XDNA2 PnP instance on Windows 11 x64. An already sufficient working driver satisfies the step without a download. The privileged process downloads from the compiled URL into a fresh administrator-controlled directory, checks the bytes before and after writing, expands the CAB, checks the INF and catalog, and asks Windows to verify the catalog signature. SetupAPI checks that the single INF has a compatible driver node of the expected version. The executor rechecks the device after staging.

The signed INF also matches an older AMD PCI ID. A global install of all matching devices could change that device. SetupCopyOEMInf stages the verified package in the Windows driver store. DiInstallDevice receives the specific device instance, a compatible driver selected from that single published INF and flags zero. Its reboot flag maps to 3010. The caller schedules any restart after journaling the result. Only a subsequent ordinary-user probe can establish readiness. See [DiInstallDevice](https://learn.microsoft.com/en-us/windows/win32/api/newdev/nf-newdev-diinstalldevice) and [SetupDiBuildDriverInfoList](https://learn.microsoft.com/en-us/windows/win32/api/setupapi/nf-setupapi-setupdibuilddriverinfolist).
