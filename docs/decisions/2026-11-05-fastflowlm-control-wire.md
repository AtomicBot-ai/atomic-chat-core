---
date: 2026-11-05
title: "Publish FastFlowLM compatibility and operation recovery on control protocol 2"
---

# Publish FastFlowLM compatibility and operation recovery on control protocol 2

The app and Atomic Server need to agree on the meaning of a model check before downloading files or asking the operator to install a driver. A completed compatibility check returns HTTP 200 and a verdict, including the engine or host requirement that blocks the model. A failed control action uses the existing error envelope. Missing engine maps to 404, invalid installation and local-only identity mismatch to 422, host readiness and device contention to 409, timeout to 504 and process crash to 500. The error code identifies the cause within each status.

Engine versions use the existing engine-build row. The core chooses the active build and applies updates by swap. Provider-specific routes and event names extend control protocol 2. Clients can continue to read existing engines, managed operations and receipts.

A preparation event carries the same operation snapshot as recovery by ID. The operation ID and increasing revision identify its durable state. The SSE cursor identifies a position in one owner's event stream. After a gap or restart the client recovers through the operations endpoint. Approval names the expected revision and displayed plan digest. The plan includes account and optional service, recipe and manifest digests, package versions, sources and hashes, changes and blockers. After consent, both GET and SSE expose the same nullable `pending_host_step`. A pending step supplies the fixed OS action, recipe identity, nonce, operation revision and parameter digest. Its parameters identify the immutable manifest and recipe revision and the runtime account, launch mode and service. This lets a reattached client construct the existing host request and bind its receipt to precisely that step. Section 4 implements the coordinator, privileged validation and execution.

A maintenance begin response grants permission to modify files only when `ready_to_mutate` is true. Status distinguishes `stopping`, `held` and `completed` so that a client recovering after disconnect can distinguish waiting for unload from an already released guard. Only `held` permits mutation. Section 5.4 implements guard persistence and enforcement.

The core-owned wire examples and the desktop relay sample are in `test/fixtures/fastflowlm/`; their provenance, comparators and reproduction command live beside them.
