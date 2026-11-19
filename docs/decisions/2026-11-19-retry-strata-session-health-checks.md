---
date: 2026-11-19
title: "Retry Strata session health checks before unloading"
---

# Retry Strata session health checks before unloading

The Strata runtime verifies its owned Control instance and its authenticated HTTP telemetry once every five seconds after loading. A slow or failed check used to close the local gateway immediately, interrupting chat streams even when the engine could recover.

Keep the loaded session and gateway for the first two failed checks. Close the gateway and stop the engine after three consecutive failures. A check that verifies both Control and telemetry resets the count. Initial loading still requires both checks to pass before the gateway opens. Explicit unload and shutdown still cancel the monitor immediately. GPU ownership still depends on confirmed process exit.

Log the attempt and cause of every failure in the core log, along with any recovery. Report the final cause in the session death event. Diagnostics use status codes and summaries so credentials and response bodies stay out of the log.

Owner: team.
