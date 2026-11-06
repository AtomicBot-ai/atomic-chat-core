---
date: 2026-11-06
title: "Separate runtime memory preparation from driver recipes"
---

# 2026-11-06 — Separate runtime memory preparation from driver recipes

- **Context:** Low Linux RLIMIT_MEMLOCK was only repairable through a qualified driver recipe. A healthy Arch NPU with installed drivers was blocked; a login or service drop-in alone did not change the live owner.
- **Decision:** Add the built-in `linux.configure-runtime-memlock` host action, independently of driver manifests. Its fixed policy raises the running owner to at least 2 GiB, preserves a higher hard limit, and persists service or account limits. Consent binds PID, process start ticks, boot ID and runtime account/service. The privileged executor checks UID and systemd User/MainPID before mutation. A system service may be authorized by a different administrator; interactive and user-service preparation must belong to the invoking user.
- **Consequences:** No driver download, reboot, relogin or server restart is needed for a memory-only correction. User services also get a per-UID manager drop-in and a live manager limit, so restarting a low-limit manager is unnecessary. Qualified driver transactions reuse the same memory executor under their single elevation. Old issued requests retain their legacy activation behavior. Readiness is always re-probed in the unprivileged core.
- **Limits:** Account limits apply to future PAM login sessions, not already running parent shells/GUI applications. A new server launched by such a parent can require authorization again. `prlimit` addresses a numeric PID: UID/start/boot checks before and after reject observed identity changes, but do not make the syscall atomic with those checks. The helper has no arbitrary command, file destination, capability grant or user-selected memory size.
- **Alternatives:** Keeping memory under the Ubuntu/kernel recipe incorrectly couples an OS resource limit to package qualification. Persistent CAP_SYS_RESOURCE on the application grants more power than needed. Restarting the user manager would interrupt unrelated user services.
- **Owner:** team.
- **Links:** `add-fastflowlm-runtime`; [polkit authentication agents](https://polkit.pages.freedesktop.org/polkit/pkexec.1.html).
