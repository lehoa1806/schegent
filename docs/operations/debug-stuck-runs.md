# Debug Stuck Runs

A stuck run is one that the state machine reports as in-flight but is making no observable progress (no new audit entries, no stdout, no phase transitions). This guide walks through the standard diagnosis flow.

## Step 1 — Identify the run

The first step is checking the UI indicators (see [Sidebar UI Guide](sidebar-ui.md) and [Dashboard UI Guide](dashboard-ui.md)). 

Capture the following:
- **`runId`** (also the default `correlationId`) — You can find this in the Dashboard's **Active & Pending Queue** list by hovering over the feature name, or in the Live Activity Feed.
- **Current phase** — Look at the active-phase line in the sidebar (`implement · 3/7 tasks`) or the highlighted tile in the Dashboard's phase progression (`[ IMPLEMENT ⏳ ]`).
- **Run Status** — Check the sidebar status dot. 
  - Green (`in-flight` without progress) means it's stuck running.
  - Orange (`paused`) means it explicitly stopped. 

If the run is paused, the Dashboard's Queue list will display the `pausedReason`:
- `pausedReason: "rate-limited"`: This is **not** a stuck run — see [handle-rate-limits.md](handle-rate-limits.md).
- `pausedReason: "stalled"`: The CLI monitor specifically detected a lack of stdout. Continue to Step 2.

## Step 2 — Reconstruct the timeline by correlationId

```bash
grep '"correlationId":"<runId>"' .schegent/audit.log | jq -c .
```

Order matters — the entries are time-ordered. Look for:

- The most recent `phase-start` (the phase the run is on).
- The most recent `monitor-stdout-line` or `monitor-stderr-line` (the last line the CLI emitted).
- A `monitor-stall` entry (the monitor's own detection signal).

If the most recent monitor line is older than `schegent.invocation.timeoutSeconds` (default 5400s), the per-phase idle timeout would normally have fired. The timer resets on every CLI output chunk, so the gap between "now" and the last monitor line is the right thing to compare. If you don't see a `phase-end` with `outcome: failure`, something prevented the timeout from firing — note the `phase` and `correlationId` and continue.

## Step 3 — Check the workspace lock

The lock state lives in `workspaceState`. The dashboard shows `lockOwnerId` and last heartbeat. If the heartbeat is more than `STALENESS_THRESHOLD_MS` old, the lock is stale and reclaimable by the next run.

Stale lock without termination usually means:

- VS Code crashed mid-run.
- Extension was uninstalled mid-run.
- The host process was killed externally.

Reclaiming a stale lock is automatic — `schegent.resume` and the next auto-drain attempt both reclaim. If reclamation fails repeatedly, run `schegent.reset` ([reset-safely.md](reset-safely.md)).

## Step 4 — Check for monitor signals

Schegent's CLI monitor emits structured events:

| Event | Meaning |
|---|---|
| `monitor-stall` | No stdout for > stall threshold; the monitor surfaces this as a `pausedReason`. |
| `monitor-rate-limited` | CLI emitted a rate-limit signal. |
| `monitor-progress` | Sub-phase progress detected. |
| `monitor-invocation-summary` | Phase completed (success or failure). |

If the monitor emitted no events at all for the current phase, the spawn likely never produced stdout. Check the CLI binary path (`schegent.cli.path`) and whether `claude` is on `PATH`.

## Step 5 — Try retry / resume

In order of escalation:

1. **Schegent: Resume Paused or Failed Workflow** (`schegent.resume`) — picks up from the recorded phase.
2. **Schegent: Retry Active Run** (`schegent.retryActiveRun`) — re-runs the phase from scratch.
3. **Schegent: Cancel In-Flight Workflow** (`schegent.cancel`) — terminates the run; auto-drain takes over if more queue items are pending.
4. **Schegent: Reset Workspace State** (`schegent.reset`) — last resort; see [reset-safely.md](reset-safely.md).

**These palette commands name no run, so with several in flight they refuse rather than guess.** You will see one of:

- `several runs are in flight; cancel a specific task instead.`
- `several runs are resumable; resume one from the sidebar instead.`

That is not a malfunction — cancelling or resuming a run you were not looking at is silent and, for cancel, unrecoverable. Name the target instead: use the per-queue controls in the sidebar or Dashboard, or cancel by task. With exactly one matching run the commands behave exactly as they always did.

## Step 6 — Capture for an issue report

If the run can't be recovered, capture:

- `correlationId`
- The audit log slice for that ID (sanitized; safe to share).
- Schegent extension version.
- Claude CLI version (`claude --version`).
- Whether the watchdog was active.

Open an issue against the project with the slice attached.

## Common patterns

| Pattern | Likely cause | Action |
|---|---|---|
| Phase starts, no stdout, phase eventually times out | CLI binary missing or wrong | Verify `schegent.cli.path`. |
| `monitor-stall` repeatedly with no resume | Stall threshold too aggressive for your workload | Increase `schegent.invocation.timeoutSeconds`. |
| `monitor-rate-limited` followed by long silence | Watchdog not polling | Verify `schegent.watchdog.enabled`. |
| `audit.hydration.warning` entries cluster around the run start | Workspace touched by a newer Schegent build | Upgrade the extension. |
| Phase says `in-flight` but `lockOwnerId` matches no live run | Stale lock | Wait for staleness window or reset. |

## Where to look next

- [inspect-audit-logs.md](inspect-audit-logs.md) — entry shape, sanitization, hydration warnings.
- [recover-after-restart.md](recover-after-restart.md) — restart-vs-stuck distinction.
- [reset-safely.md](reset-safely.md) — when nothing else works.
