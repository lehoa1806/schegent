# Troubleshooting

A list of the things that go wrong, what they look like, and how to fix them.

## CLI not detected

**Symptom:** Sidebar header shows **CLI not found** in red.

**Causes and fixes:**

- **The CLI binary is not on `PATH`.** Open a fresh VS Code terminal and run `which claude` (POSIX) or `where claude` (Windows). If empty, the binary is not on `PATH`. Set `schegent.cli.path` to the absolute path.
- **VS Code's `PATH` differs from your interactive shell.** Login-mode shells (e.g., `.zprofile`) do not run for VS Code's environment by default. Set `schegent.cli.path` explicitly to bypass `PATH` resolution.
- **The binary is installed but not executable.** `chmod +x /path/to/claude` if you compiled or downloaded it manually.

## CLI unauthenticated

**Symptom:** Sidebar header shows **CLI unauthenticated** in yellow.

**Fix:** Run `claude login` in a fresh terminal. Re-open VS Code (or click the badge to re-probe) once logged in.

## Sidebar is empty after installing

**Symptom:** Schegent is installed, the icon is in the activity bar, but the sidebar shows nothing.

**Causes:**

- **No workspace folder is open.** Schegent only operates on workspace folders. Open one via `File > Open Folder`.
- **Workspace trust is not granted.** Schegent is intentionally inert in untrusted workspaces. Look for the trust prompt at the top of VS Code and accept it.

## Multi-root workspace — `.schegent/` only appears in one folder

**Symptom:** You opened a `.code-workspace` containing several folders, but the `.schegent/` directory was created in only one of them. The audit log and run history are not visible from the other folders.

**Cause:** This is by design. Schegent treats the **first folder** in the `.code-workspace` as the canonical workspace folder. All state — `.schegent/`, the audit log, the per-run session tree, the queue, the lock — lives under that folder. Other folders are ordinary VS Code roots that Claude can read and edit, but Schegent itself does not create state in them.

**At activation,** Schegent surfaces a one-shot informational toast naming the canonical folder. If you missed it, look at the audit log:

```bash
jq -c 'select(.eventType == "multi-root.warning-shown") | {timestamp, payload}' .schegent/audit.log
```

The payload records the folder count and the canonical folder's name (folder name only — never the absolute path).

**Fix:** None required if the chosen folder is correct. To change which folder Schegent activates against, reorder the folders in the `.code-workspace` file so the desired folder is listed first, then reload the window. To hide the warning toast for this workspace, set `schegent.multiRoot.suppressWarning` to `true` in the `.code-workspace` `settings` block (window-scope).

**v1 limitations:** No operator-chosen canonical folder, no per-folder queues, no migration when folders are reordered mid-session. See [Concepts → The Workspace Lock](../concepts/workspace-lock.md#multi-root-workspaces) for the full description and the v2 follow-ups.

## A run looks stuck

**Symptom:** The in-flight task is showing as running, but nothing is updating in the phase log feed.

**Diagnose:**

1. Look at the dashboard's runtime debug log. A `monitor-stall` event means the host has noticed.
2. Open the raw transcript (`.schegent/sessions/raw-<runId>.log`) and look at the most recent lines. The CLI may be in a long-running tool call (e.g., a 10-minute `npm test`).
3. Check the PID badge. `ps -p <PID>` confirms whether the subprocess is alive.

**Resolutions:**

- **Genuinely stuck (subprocess alive, no progress):** click **Pause**. Investigate. Either Restart Active Phase or Resume.
- **Genuinely stuck (subprocess dead, no audit event):** the host may be in an inconsistent state. Reload Window. The recovery path will reconcile the run state.
- **Just slow:** wait. A long tool call will produce its next output when complete.

## Lock looks stuck

**Symptom:** The queue cannot drain, but the in-flight task seems missing.

**Possible causes:**

- **A run is paused and you forgot.** The most common cause. Check the paused list. Resume or cancel to release the lock.
- **The audit log shows a run that the sidebar does not.** Persisted state is out of sync. Reload Window; the recovery path reconciles.
- **A hard crash left state inconsistent.** Run **Reset Workspace State** (`schegent.reset`). This is destructive — it clears the queue, runs, and pause state. It does **not** delete the audit log or session tree.

See [The Workspace Lock](../concepts/workspace-lock.md) for the underlying mechanism.

## Tasks reordered but the audit log shows rejection

**Symptom:** You drag a task; the UI moves it briefly, then snaps back. Audit log shows `task-reordered` with `outcome: rejected`.

**Causes (the `cause` discriminator):**

- `secondary-host` — you are in a non-primary VS Code window. The primary host gates mutating commands.
- `task-not-pending` — the task is no longer in `pending` (perhaps it just started in-flight).
- `invalid-position` — the destination position is out of range.
- `no-op` — the destination position equals the current position.

## "Not primary host" errors

**Symptom:** Mutating commands fail. Audit log shows `reason: 'not-primary-host'`.

**Fix:** Close the secondary window. The primary host is the first window that activated against the workspace; switch by closing windows in order and reloading the one you want as primary.

Multi-window monitoring is supported (read-only); multi-window mutation is not.

## Phase fails with `fatal-signature` but you do not know which signature

**Diagnose:** The `fatal-signature-matched` audit event preceding the `phase-end` records:

- `signature` — the matched substring.
- `source` — `built-in` or `operator-defined`.
- `where` — `stdout` or `stderr`.

```bash
jq -c 'select(.eventType == "fatal-signature-matched") | {timestamp, signature, source, where}' .schegent/audit.log | tail -5
```

**Fix:**

- If `source: 'operator-defined'`, edit your `schegent.fatalSignatures` to remove or refine the entry.
- If `source: 'built-in'`, the failure is a known unrecoverable mode. Investigate the root cause; the signature was added for a reason.

## Phase fails with `timeout`

**Symptom:** Audit log shows `phase-end` with `cause: 'timeout'`.

**Causes:**

- The CLI produced no stdout/stderr output for `schegent.invocation.timeoutSeconds` (default 5400s = 90 minutes). The timer resets on every output chunk, so this triggers only when the CLI is genuinely idle.
- The CLI was alive but stalled past the watchdog threshold.

**Fix:**

- **Bump the timeout** if the phase legitimately needs longer: set `timeoutSeconds` on the phase override.
- **Investigate the stall** if the phase should not be that long: open the raw transcript, see what was the last tool call. Fix the underlying issue (e.g., a hanging test).

## Phase fails with `nonzero-exit`

**Symptom:** Audit log shows `phase-end` with `cause: 'nonzero-exit'` and an `exitCode` field.

**Diagnose:** Open the raw transcript and read the last 50 lines. The CLI's stderr typically has the reason.

**Fix:** Depends on the exit code and the stderr. Common cases:

- `1` — generic failure. Read the stderr.
- `137` — killed (typically OOM). Check system memory; consider lowering model effort.
- `139` — segfault. Likely a CLI bug; capture the raw transcript and report.

## Retry storm — same phase fails 5 times

**Symptom:** Audit log shows 5 `retry-scheduled` events in a row, then `queue-paused` with `pauseSource: 'cascade'`.

**Causes:**

- A persistent rate-limit (more aggressive than the schedule expected).
- A persistent transient error that is not actually transient.

**Fix:**

1. Inspect the `retry-scheduled` events. Same `cause` every time? If so, the classification is consistent.
2. For rate-limit: wait until the actual reset, then `schegent.resumeQueue`.
3. For transient-error: investigate the root cause. The classification may be wrong (e.g., the failure is actually deterministic). Cancel the run and re-enqueue after fixing.

## Runtime log writes stopped

**Symptom:** `.schegent/syslog` is not growing despite operator activity. The Output channel shows a warning about suppression.

**Cause:** The writer hit a non-ENOENT I/O error (disk full, permissions). Further writes to that path are suppressed until cleared.

**Fix:**

1. Resolve the underlying issue (free disk, fix permissions).
2. **Save the runtime log settings again** — even with the same values. The post-save callback clears the suppression map. This is the recovery affordance.

The setting save can be triggered from the sidebar settings panel.

## Verbose diagnostics not capturing

**Symptom:** You set `schegent.logging.verbose: true` but `.schegent/sessions/<runId>/diagnostics/` is empty.

**Causes:**

- **You set it mid-phase.** The setting is read at phase entry; the in-flight phase is not retroactively captured. The next phase will capture.
- **The phase did not run.** A breakpoint or pause may have intervened before the phase reached the runner.

**Fix:** Set verbose before the phase you want to capture. Verify with the next phase boundary.

## Wake-up scheduler did not fire

**Symptom:** No `wakeup-runner-invocation` events in the audit log over the expected timeframe.

**Diagnose:**

- Is the OS-native entry installed? Check the audit log for `wakeup-daemon-installed`.
- Is the OS-native entry **for this user**? The wake-up scheduler is per-user; another user on the same machine has its own entries.
- Did `schegent.wakeUp.enabled` get set to `false` somewhere?

**Fix:**

- Toggle wake-up off and back on to reinstall the OS entry.
- For platform-specific verification:
  - macOS: `launchctl list | grep schegent`.
  - Linux: `crontab -l` or `systemctl --user list-timers`.
  - Windows: Open Task Scheduler and look under `\Schegent\Wakeup`.

## Configuration changes do not take effect

**Symptom:** You changed `schegent.phases` (or any other setting) but the next phase ran with the old value.

**Causes:**

- **The in-flight run has a frozen snapshot.** Settings changes apply to the *next* enqueued run, not the in-flight one. This is by design.
- **The setting is application-scoped and you saved to workspace.** Application-scoped settings (e.g., `schegent.cli.path`) ignore workspace overrides. Check the scope in the [Settings Reference](../reference/settings.md).

**Fix:** Cancel the in-flight run if you need the setting to apply now. Re-enqueue. The new run reads the current settings into its frozen snapshot.

## Audit log is enormous

**Symptom:** `.schegent/audit.log` is multiple megabytes; greps are slow.

**Cause:** Rotation has not fired yet, or the threshold is configured high.

**Fix:**

- Force a rotation by adjusting `schegent.audit.rotation.sizeMB` to a lower value temporarily.
- Or, manually rename the file: `mv .schegent/audit.log .schegent/audit.log.<stamp>`. The next write creates a fresh active log. **You will lose live tail subscribers** on the old file — but the audit pipeline does not subscribe to its own file, so this is safe.

## Cannot find the runId

**Symptom:** You want to look at the session tree for a specific task but do not know the runId.

**Fix:** Find the task in the sidebar history; the detail view shows the runId. Or search the audit log for the task's enqueue event:

```bash
jq -c 'select(.eventType == "task-enqueued") | {timestamp, taskId, runId}' .schegent/audit.log
```

The runId is assigned when the task transitions from pending to in-flight; it appears in `phase-start` events.

## Extension does not activate

**Symptom:** Schegent icon is in the activity bar but nothing happens.

**Diagnose:**

- Open the VS Code **Output** panel, switch to the **Extensions** channel. Look for Schegent-related errors at activation time.
- Check the runtime log (`.schegent/syslog`) for the activation sequence.

**Common causes:**

- VS Code version below the minimum (1.85). Upgrade VS Code.
- A corrupted extension install. Uninstall and reinstall.
- A `workspaceState` migration failure. The audit log records `state-migrated` on success; absence after a fresh install suggests the migration did not run. Reset workspace state.

## When all else fails

1. **Capture the audit log.** Compress and attach to a bug report.
2. **Capture the runtime log.** Same.
3. **If reproducible, capture verbose diagnostics.** Enable verbose, reproduce, attach the `<runId>/diagnostics/` directory.
4. **Do not attach the raw transcript** unless asked — it is unredacted and may contain sensitive context.

File issues at the extension's repository. Include:

- OS and VS Code version.
- Claude CLI version (`claude --version`).
- The audit log snippet around the failure.
- Your `settings.json` for `schegent.*` keys.

The next page is [Security → Operator Threat Model](../security/threat-model.md).
