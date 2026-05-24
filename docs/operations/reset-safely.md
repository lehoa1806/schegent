# Reset Safely

Schegent persists state to VS Code `workspaceState` and the audit log at `.schegent/audit.log`. Use the documented reset commands rather than ad-hoc deletion.

## When to reset

- Workflow appears stuck and `Resume` doesn't help.
- State was corrupted by a crash mid-write (rare but possible).
- You want to start the workspace clean.
- Dashboard shows snapshot inconsistencies (queue mismatch, stale lock, etc.).

## What `Schegent: Reset Workspace State` does

The `schegent.reset` command:

1. Cancels any in-flight workflow.
2. Releases the workspace lock.
3. Clears `workspaceState`:
   - active workflow run
   - queue
   - history (with `HISTORY_CAP` capped retention)
   - watchdog state
   - lock metadata
4. Re-projects an empty snapshot to both webviews (sidebar and dashboard).

It does **not** delete the audit log. `.schegent/audit.log` is preserved by design — it's the historical record.

## Step-by-step

1. **Cancel first if a run is in flight**: **Schegent: Cancel In-Flight Workflow** (`schegent.cancel`).
2. Open the Dashboard (sidebar's **Open Dashboard** button or `Schegent: Open Dashboard`) and confirm no `in-flight` item is shown.
3. Run **Schegent: Reset Workspace State** (`schegent.reset`).
4. Confirm the destructive prompt.
5. The sidebar status row drops to `idle` and the Dashboard updates to an empty snapshot.

## After reset

The `.specify/` directory still contains:

- `audit.log` and rotated archives (preserved).
- Spec Driven Development workflow artifacts (`memory/`, `templates/`, `scripts/`, `extensions.yml`, etc.).

You can now enqueue features fresh — see [start-feature.md](start-feature.md) and [schedule-multiple.md](schedule-multiple.md).

## Hard reset (last resort)

If `schegent.reset` itself fails to complete (e.g., extension can't activate):

1. Close the workspace.
2. Open the **VS Code global storage** for the workspace and delete the `schegent` keys, OR delete the workspace from VS Code's recent list.
3. Reopen and let the extension activate cleanly.

You can also delete `.schegent/audit.log` manually if you want to discard history. This is **not** required by the reset command — only do this if you specifically want to discard the historical record.

## What you should not do

- **Do not** delete `.schegent/audit.log` while a run is in flight — it can interleave with the writer.
- **Do not** edit `workspaceState` directly via VS Code's APIs while the extension is running.
- **Do not** delete `.specify/` while the extension is running. Close VS Code first if you must.

## Re-enqueuing previous work

History entries survive across resets via the audit log archives, but they do not auto-rehydrate. To replay a previous feature description:

1. Find it in an audit archive: `grep '"workflow.started"' .schegent/audit.log.<archive>`
2. Copy the original description from the entry payload.
3. Paste into the Dashboard's queue input or invoke `schegent.schedule` from the Command Palette.

## Where to look next

- [start-feature.md](start-feature.md) — fresh run after a reset.
- [recover-after-restart.md](recover-after-restart.md) — restart-vs-reset distinction.
- [debug-stuck-runs.md](debug-stuck-runs.md) — diagnose before resetting.
