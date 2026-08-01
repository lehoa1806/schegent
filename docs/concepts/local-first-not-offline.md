# Local-first does not mean offline execution

Status: Accepted product-boundary decision (2026-08-01)

Schegent is local-first: the extension host, webviews, queue state, audit log,
runtime log, raw transcripts, and session evidence run or remain on the
operator's workstation. That boundary does **not** make AI execution offline.
Claude Code, Codex, and Agy may require provider network access and valid
credentials whenever Schegent starts a phase.

## Product decision

Offline AI execution is not a supported promise for the current release.
Schegent supports local queue management and local evidence access while the
network is unavailable, but it does not claim that a configured backend can
execute without a provider connection. A future local-model adapter may add
that capability; it must advertise and prove it explicitly.

The Dashboard queue composer states this boundary before submission:
"Local-first, not offline: running this queue may contact configured backend
providers."

## What works without provider connectivity

| Capability | Current behavior without provider connectivity |
|---|---|
| Open the sidebar or Dashboard | Works from local projected state. |
| Inspect queue, history, settings, audit, and existing session evidence | Works while local storage is readable. |
| Enqueue or edit pending work | Persists locally. Leave the queue `idle-pending` or operator-paused to prevent an execution attempt. |
| Start or resume a phase | Not guaranteed. The configured backend may fail authentication, reachability, or provider requests. |
| Automatic retry or rate-limit recovery | Remains stateful locally, but the next backend attempt still needs whatever connectivity that backend requires. |
| Wake-up scheduler invocation | Not offline-capable for the current Claude-backed implementation. |

There is no automatic "offline mode" and no network reachability detector.
Queue-only/no-execution behavior is explicit operator intent: keep an
`idle-pending` queue unstarted, or pause the queue before connectivity is
removed. Schegent never silently substitutes a different model or backend.

## Preflight and failure behavior

The guarded start path probes every effective runner in the selected pipeline.
That probe verifies the configured executable and its supported command
surface; it is not a provider health check and does not prove that credentials,
DNS, TLS, proxy configuration, quota, or the remote API will remain available.

Once execution begins, the runner's bounded stdout/stderr and exit status drive
normal error classification. Rate limits use the delayed-retry path. Fatal or
unclassifiable failures stop or pause according to controller policy, and local
state/evidence remains available for diagnosis. Schegent does not label a
binary-only probe as "offline ready."

## Capability-discovery prototype

If an offline-capable backend is proposed, discovery must be a separate
preflight service keyed by `BackendRunnerKind`; it must not widen or overload
the invocation-only `BackendRunner` contract. The minimum projected result is:

```ts
interface BackendExecutionCapability {
  runner: 'claude' | 'codex' | 'agy' | string;
  binary: 'available' | 'unavailable';
  execution: 'network-required' | 'offline-capable' | 'unknown';
  readiness: 'ready' | 'not-ready' | 'unknown';
  checkedAt: string;
  reasonCode?: string;
}
```

Rules for a production implementation:

- Discovery is bounded, cancelable, and never sends workspace content.
- `unknown` fails closed for an "offline execution" badge; it must not be
  presented as ready.
- Provider reachability is time-scoped evidence, not a durable guarantee.
- The result may guide UX but cannot bypass the normal run-start probe.
- Raw credential, proxy, path, or provider error text is never projected;
  reason codes pass through the existing sanitization and audit boundaries.

This prototype intentionally remains documentation-only because none of the
currently supported adapters claims offline execution. Adding runtime probing
without such a backend would create a misleading health signal.

## Revisit criteria

Reconsider the decision only when a concrete adapter can execute the full
phase contract without provider connectivity and has deterministic tests for
output bounds, cancellation, session ownership, fail-closed classification,
and offline startup. Until then, issues caused solely by unavailable provider
connectivity are supported degraded operation, not violations of an offline
product promise.
