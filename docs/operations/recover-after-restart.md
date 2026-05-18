# Recover After VS Code Restart

Schegent persists state to VS Code `workspaceState` and the JSONL audit log at `.schegent/audit.log`. On extension activation, both are rehydrated and the UI is re-projected.

## What survives a restart

| Surface | Persistence | Hydrated from |
|---|---|---|
| Active workflow run | `workspaceState` | `STATE_SCHEMA_VERSION` snapshot |
| Queue | `workspaceState` | shared snapshot |
| History | `workspaceState` (capped at `HISTORY_CAP`) | shared snapshot |
| Lock | `workspaceState` | shared snapshot (heartbeat + staleness check) |
| Audit log | `.schegent/audit.log` (JSONL) | tail re-scanned by `audit-log-parser` |
| Watchdog | `workspaceState` | shared snapshot |

The CLI subprocess does **not** survive a VS Code restart. If a run was in flight, the workspace lock will appear stale and reclaimable after `STALENESS_THRESHOLD_MS`.

## After a clean restart

1. Open the workspace.
2. Wait for the **Schegent** activity-bar icon to render the latest snapshot.
3. Read the **Live activity feed** — recent audit summaries are projected from the parsed log.

If the active run was mid-flight at the time of restart:
- The lock appears with the previous `runId`.
- After `STALENESS_THRESHOLD_MS`, **Schegent: Resume Paused or Failed Workflow** (`schegent.resume`) reclaims the lock and resumes from the recorded phase.
- Or you can run **Schegent: Cancel In-Flight Workflow** (`schegent.cancel`) to discard.

## Hydration warnings

Audit entries with an unrecognized `eventType` or a future `schemaVersion` are **preserved** with a warning emitted as `audit.hydration.warning`. They surface in the live activity feed. You can also tail the log:

```bash
grep '"audit.hydration.warning"' .schegent/audit.log
```

This typically means the workspace was last touched by a newer Schegent build. The current parser will continue to function; the warned entries are kept for forward compatibility.

## When state is corrupted

If hydration aborts on a hard error (state from a future runtime version, or unreadable JSON):

1. Use **Schegent: Show Audit Log** to copy any context.
2. Run **Schegent: Reset Workspace State** (`schegent.reset`) — see [reset-safely.md](reset-safely.md).
3. Re-enqueue any incomplete features.

## Troubleshooting

| Symptom | Likely cause | Action |
|---|---|---|
| Dashboard shows empty queue but items existed | Hydration failed silently | Check the dev tools console; run `schegent.reset` if needed. |
| Lock is stuck | Crash before release | Wait `STALENESS_THRESHOLD_MS` (default a few minutes) or run `schegent.reset`. |
| Audit log appears truncated | Rotation just fired | Look for `.schegent/audit.log.<stamp>` archives. Active log is always `.schegent/audit.log`. |
| Sidebar status row shows `paused` with no obvious reason | Watchdog detected rate-limit | See [handle-rate-limits.md](handle-rate-limits.md). |

## Pending-retry restart resilience (feature 011)

If a run was waiting on a delayed retry at restart time (a
`retry-scheduled` event followed by a quiet log tail), the
`pendingRetryAt` and `pendingRetryCause` fields persisted on the
`WorkflowRun` record drive the resume handshake on next activation.
`WorkflowController.resumeExistingFromActivation()` computes
`delay = max(0, pendingRetryAt - Date.now())` and either resumes on
the next tick (if the deadline has passed) or re-arms the watchdog
with `durationOverrideMs = delay` so the original deadline is
honored across the restart. SC-012 asserts this behavior.

To check what state Schegent will resume into, scan for the most
recent retry transition:

```bash
grep -E 'retry-scheduled|retry-manual|retry-recovered|queue-paused' .schegent/audit.log | tail -n 5
```

See [delayed-retry-and-manual-override.md](delayed-retry-and-manual-override.md)
for the full state machine.

## Where to look next

- [debug-stuck-runs.md](debug-stuck-runs.md) — reconstruct a timeline by `correlationId`.
- [delayed-retry-and-manual-override.md](delayed-retry-and-manual-override.md) — pendingRetryAt restart contract.
- [inspect-audit-logs.md](inspect-audit-logs.md) — interpret entries.
- [reset-safely.md](reset-safely.md) — wipe state when nothing else helps.
