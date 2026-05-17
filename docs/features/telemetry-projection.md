# Telemetry Projection

While a phase is running, the sidebar surfaces a small set of **live telemetry** — the PID of the active subprocess, a coarse status string, and the elapsed time. This data is intentionally ephemeral: it lives in memory, never on disk, and is cleared as soon as the phase ends.

## What the projection shows

When the in-flight task is running, the sidebar header for that task shows:

- **PID badge** — the process id of the Claude CLI subprocess. Useful for the rare case where you want to attach to the process from a terminal.
- **Elapsed time** — a live-updating counter since the phase started.
- **Status** — a coarse string (e.g., `running`, `paused-pending-confirmation`). The status is a closed enum; new statuses require a code change.

The dashboard surfaces the same telemetry alongside the runtime debug log.

## What "ephemeral" means

The telemetry projection lives on `WorkflowSnapshot.telemetry` — a field on the projected snapshot the host pushes to the webview. The snapshot is rebuilt on every state change.

When the phase ends:

1. The host emits `phase-end` and `monitor-invocation-summary`.
2. One snapshot publish later, `WorkflowSnapshot.telemetry` is cleared to `null`.
3. The sidebar's PID badge and elapsed counter disappear.

Crucially, **`TelemetrySnapshot` is never persisted**:

- Not written to `WorkflowRun`.
- Not written to the audit log.
- Not written to any on-disk file.

The audit log records *intent and outcome*; the telemetry projection shows *current operational state*. The two are distinct.

## What survives in the audit log

A handful of telemetry-adjacent values do appear in the audit log because they belong there:

- The **PID** appears in `monitor-invocation-started` payloads and `monitor-invocation-summary` payloads.
- The **elapsed duration** appears in `phase-end` and `monitor-invocation-summary` payloads (computed at termination, not live).

These are the only telemetry-adjacent values allowed in audit events. The audit log stays **paths-free** and metadata-only.

## Sanitization

Telemetry text fields (only `status` today; a closed enum) pass through the central sanitization function at the `StateProjector.updateTelemetry` boundary. There is a single sanitization point; `SECRET_PATTERNS` is the single source of truth.

The webview never re-sanitizes the telemetry. The display is direct.

The status enum is closed — there are no operator-supplied strings — so in practice the sanitizer is a no-op for telemetry. The sanitizer is wired through anyway as defense-in-depth.

## Why ephemeral?

Two reasons:

### Privacy

A live PID and status are operationally useful but not durable evidence. Recording them in the audit log would bloat the log with churn (a status string can change many times per phase) and would leak operational state that the audit log is meant to *not* leak.

### Honesty

If the telemetry were persisted, an operator reading old `WorkflowRun` state would see what looks like live PIDs and status strings — but those are stale. The persisted record would mislead. By keeping the projection ephemeral, the only place to see "what is running right now" is the live UI.

## Limits

- **No telemetry-driven audit events.** You cannot subscribe to telemetry changes and emit audit events from them. The host's existing monitor events (`monitor-invocation-started`, `monitor-progress`, etc.) are the audit-log surface.
- **No historical telemetry.** Once a phase ends, the projection is cleared. To reconstruct "what was running an hour ago", read the audit log.
- **No telemetry for paused tasks.** A paused task has no active subprocess; the telemetry is `null`. The pause cause and pause timestamp live in `WorkflowRun.manualPauseAt` / `manualPauseCause` instead.

## What this means for operators

When you look at the sidebar header for an in-flight task and see a PID, that PID is **right now**. If you `ps -p <PID>` in a terminal, you will see the running Claude CLI process. If you wait one second and check again, the PID may be the same (the phase is still running) or absent (the phase ended).

You should not screenshot the PID and refer to it later — by the time you look again, the value is meaningless. The audit log has the historical record; the live UI has the live state. They are different tools for different jobs.

The next feature is [Runtime Logging](runtime-logging.md).
