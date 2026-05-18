# Wake up — Troubleshooting runbook

The Wake up subsystem pre-warms the operator's 5-hour rolling Claude
allocation window by scheduling a context-isolated 1-token CLI ping
through the host OS's native scheduler (launchd / Task Scheduler /
cron / systemd-user). This runbook is the operator-facing field guide
for inspecting, diagnosing, and recovering Wake up state.

For the feature-level walkthrough that proves SC-001 / SC-002 / SC-003 /
SC-005 end-to-end, see
[specs/014-wake-up/quickstart.md](../../specs/014-wake-up/quickstart.md).

---

## File locations at a glance

Every Wake up artifact lives under VS Code's per-extension
**global storage** directory (NOT inside the open workspace) so that
nothing the priming invocation touches can be mistaken for a workspace
ingest:

| Path | Purpose |
|---|---|
| `<globalStorageUri>/wakeup/runner.js` | Mirror of `dist/wakeup-runner.js`, installed at Save |
| `<globalStorageUri>/wakeup/workspace-roots.json` | Roots-only snapshot, refreshed at activation + Save; used by the runner to enforce `cwdInsideWorkspace === false` |
| `<globalStorageUri>/wakeup/invocations.log` | Append-only JSONL outcome log written by the runner |
| `<globalStorageUri>/wakeup/session.log` | Append-only on-disk session log (feature 031). Each successful or failed invocation appends one `=== wakeup-block … ===` block with sanitized `OUT:` / `ERR:` lines. 32 MB soft trim at block boundary; 128 MB hard cap emergency truncate. |

Resolve `<globalStorageUri>` per platform:

- **macOS / Linux**:
  `~/Library/Application Support/Code/User/globalStorage/<publisher>.<name>/wakeup/`
  (on Linux, swap the `Library/Application Support/Code/` prefix for
  `~/.config/Code/`).
- **Windows**: `%APPDATA%\Code\User\globalStorage\<publisher>.<name>\wakeup\`.

The OS-scheduler artifacts (one entry per host, identifier
`com.schegent.wakeup`) live outside global storage:

| Platform | Artifact |
|---|---|
| macOS | `~/Library/LaunchAgents/com.schegent.wakeup.plist` |
| Windows | Task Scheduler entry `\Schegent\WakeUp` |
| Linux (systemd-user) | `~/.config/systemd/user/com.schegent.wakeup.{service,timer}` |
| Linux (cron) | `crontab -l` line tagged `# schegent-wakeup` |

---

## Reading `invocations.log`

Every runner invocation appends one JSON object per line. Field
contract:

| Field | Meaning |
|---|---|
| `timestamp` | ISO-8601 timestamp the runner started |
| `durationMs` | wall-clock duration |
| `claudeExitCode` | numeric exit code, `null` if timed out |
| `timedOut` | `true` if the 60 s subprocess deadline tripped |
| `ephemeralCwd` | absolute path of the ephemeral working directory used for the spawn |
| `cwdInsideWorkspace` | MUST be `false`. If `true`, the runner aborted before invocation — file a bug citing FR-008 / SC-003 |
| `lockAcquired` | `true` for the run that won the per-host lock; `false` for an overlap that skipped (FR-021) |
| `triggerSource` | `scheduled` or `manual`; absent legacy rows are scheduled |
| `status` | `succeeded`, `failed`, `timed-out`, or `skipped` |
| `rawResponse` | bounded local response text; the UI applies host sanitization before rendering |
| `errorReason` | failure reason, if any |
| `correlationId` | (feature 031) UUIDv4 stamped onto the corresponding `session.log` block header. Absent on legacy rows and on lock-skipped rows. |
| `requestedModel` | (feature 031) the operator's selection literal — `'runner-default'` or a member of the closed registry (`'claude-opus-4-7'`, `'claude-sonnet-4-6'`, `'claude-haiku-4-6'`). Falls back to `'runner-default'` on any unrecognized value at read time. |
| `actualModel` | (feature 031) what the runner actually invoked. Equal to `requestedModel` for known ids; collapses to `'runner-default'` when an unsupported id was written to the settings mirror (no `--model` flag is appended to the CLI spawn). |
| `sessionLogBytesAppended` | (feature 031) bytes the session-log writer reported as appended; ground truth from the writer's O_APPEND write. Absent for lock-skipped invocations (no block is written). |
| `sessionLogTrimmed` | (feature 031) `true` when the soft-cap retention pass ran during this invocation; `false` otherwise. |

Recommended inspection commands:

```bash
# Last 5 invocations
tail -n 5 "<globalStorageUri>/wakeup/invocations.log" | jq .

# Most recent that timed out
grep '"timedOut":true' "<globalStorageUri>/wakeup/invocations.log" | tail -n 1 | jq .

# Confirm context isolation across the last 24 h
jq -c 'select(.cwdInsideWorkspace == true)' \
  "<globalStorageUri>/wakeup/invocations.log"
# expected: zero output
```

---

## Model selection (feature 031)

`Dashboard → Settings → Wake up` ships with a **Model** dropdown listing
four options:

| Option | Persisted value | Behaviour |
|---|---|---|
| Default (runner-chosen) | `'runner-default'` | No `--model` flag on the CLI spawn — the runner picks its built-in default. |
| `claude-opus-4-7` | `'claude-opus-4-7'` | The runner appends `--model claude-opus-4-7` to the CLI invocation. |
| `claude-sonnet-4-6` | `'claude-sonnet-4-6'` | `--model claude-sonnet-4-6`. |
| `claude-haiku-4-6` | `'claude-haiku-4-6'` | `--model claude-haiku-4-6`. |

The Save is transactional and goes through the same
`CMD_SAVE_WAKEUP_SETTINGS` flow as the four scheduler fields; the host
validates the model against the closed `WAKEUP_SUPPORTED_MODELS`
registry. Hand-editing the settings mirror file with an unsupported
id (e.g. `"claude-bogus-9000"`) does NOT crash — the runner falls
back to `'runner-default'` at spawn time and the JSONL records
`requestedModel: "claude-bogus-9000"` alongside `actualModel:
"runner-default"`. The audit row captures the same disjunction.

## Inspecting the session log

`session.log` is a plain text file with newline-delimited blocks. The
header format is fixed:

```
=== wakeup-block 2026-05-16T12:34:56.789Z id=<uuid> trigger=<scheduled|manual> model=<id|runner-default> status=<succeeded|failed> ===
OUT: <sanitized stdout>
ERR: <sanitized stderr>
```

The block body is sanitized through the same `SECRET_PATTERNS` set
that drives the structured audit log; bytes on disk are
single-pass-sanitized at capture time (no second sanitization on
read). Each block is bounded by the 64 KB capture ring; the on-disk
file is bounded by:

- 32 MB **soft** retention cap: at the end of each append, the writer
  scans `BLOCK_HEADER_PREFIX` indices and drops the oldest complete
  block(s) until the file is at or below 32 MB. The most-recent
  invocations are always preserved.
- 128 MB **hard** cap defense-in-depth: when the pre-append file size
  exceeds 128 MB (typically only reachable via hand-edit corruption),
  the writer truncates the file to ~64 MB at the next block boundary,
  or to zero with a `hard-cap-emergency-truncate` annotation when no
  boundary is found in the surviving tail.

**Reveal the file from VS Code**: the Wake up settings page displays
the absolute path under "Session log file:" and a **Reveal in OS file
manager** button. Both the path projection and the reveal command are
read-only IPCs that take no operator-supplied path — the host
composes the path from `<globalStorageUri>/wakeup/session.log`.

**Recommended inspection commands**:

```bash
# Last block (most recent invocation)
tail -n 200 "<globalStorageUri>/wakeup/session.log" \
  | awk '/^=== wakeup-block /{found=1} found' | tail -n 200

# All blocks for a specific correlation id (matches the JSONL row)
grep -A 500 "id=<uuid>" "<globalStorageUri>/wakeup/session.log" \
  | awk '/^=== wakeup-block /{n++} n<2' | head -n 200

# File size + soft-cap check
wc -c "<globalStorageUri>/wakeup/session.log"
# 32 MB soft cap = 33_554_432 bytes
```

A lock-skipped invocation (`lockAcquired: false` in `invocations.log`)
appends NO block. The corresponding JSONL row has no `correlationId`
and the UI shows "(no session log available)" for that attempt.

## Inspecting / clearing the per-host lock

A single per-host lock prevents overlapping invocations (FR-021). It is
held by the running `wakeup-runner.js` process while the priming CLI
spawn is alive; when the runner exits cleanly, the lock is released.

If a previous run crashed, the lock file may linger. Symptoms:

- `invocations.log` shows `lockAcquired: false` for every subsequent
  scheduled fire or use **Wake up now** in Settings to create a manual
  attempt without changing the installed schedule.
- Operations team reports "Wake up appears stuck".

The lock lives next to the runner output:

```bash
ls "<globalStorageUri>/wakeup/lock"
# or on Windows:
dir "%APPDATA%\Code\User\globalStorage\<publisher>.<name>\wakeup\lock"
```

To clear:

1. Confirm no `wakeup-runner.js` process is alive:
   - macOS / Linux: `pgrep -fl wakeup-runner.js` returns empty.
   - Windows: `tasklist /FI "IMAGENAME eq node.exe"` shows nothing
     bound to `wakeup-runner.js`.
2. Delete the lock file.
3. Wait for the next scheduled fire OR force one by clicking **Save**
   in the Settings UI (which re-installs and re-arms the daemon).

---

## Manual platform-listing commands

The same commands as `quickstart.md`, collected here for one-shot
copy-paste during incident response:

| Platform | List | Force-remove |
|---|---|---|
| macOS | `launchctl list \| grep com.schegent.wakeup` | `launchctl bootout gui/$UID/com.schegent.wakeup && rm ~/Library/LaunchAgents/com.schegent.wakeup.plist` |
| Windows | `schtasks /Query /TN "Schegent\WakeUp"` | `schtasks /Delete /TN "Schegent\WakeUp" /F` |
| Linux (cron) | `crontab -l \| grep '# schegent-wakeup'` | `crontab -l \| grep -v '# schegent-wakeup' \| crontab -` |
| Linux (systemd-user) | `systemctl --user list-timers schegent-wakeup.timer` | `systemctl --user disable --now schegent-wakeup.timer && rm ~/.config/systemd/user/com.schegent.wakeup.{service,timer}` |

After a manual force-remove, the next activation will reconcile state:
if `wakeUp.enabled === true` in the workspace settings, the activation
hook re-installs the entry.

---

## Deactivation-cleanup-failure escape hatch (FR-023)

When the extension deactivates, it tries best-effort to call
`daemon-manager.uninstall()` if `wakeUp.enabled === true` at the time.
If that uninstall throws (permission revoked, scheduler service down,
etc.), the failure is recorded as the audit event
`wakeup-daemon-uninstall-failed-on-deactivate` and shutdown proceeds
anyway — the extension MUST NOT block VS Code shutdown.

Detection:

```bash
grep wakeup-daemon-uninstall-failed-on-deactivate \
  "<workspaceRoot>/.schegent/audit.log" | tail -n 1 | jq .
```

The `payload.reason` field carries the sanitized error string. Recovery
is the manual force-remove from the platform listing table above; the
artifact is by definition no longer in use.

---

## Common symptoms → first checks

| Symptom | First check |
|---|---|
| Save click in Settings does nothing | Webview devtools console for `secondary-host` rejection (multi-window setup) |
| Wake up now is rejected | Confirm this is the primary VS Code host; secondary hosts reject mutating commands |
| Invocation never appears in the log | `audit.log` for `wakeup-daemon-install-failed:<platform>:<detail>` or Wake up now ACK reason |
| Record present but `ephemeralCwd` empty / blank | Runner crashed before cwd creation; check `claudeExitCode` and `errorReason` |
| `cwdInsideWorkspace` reported as `true` | **CRITICAL regression** — file a bug citing FR-008 / SC-003 |
| OS entry persists after Disable + Save | Re-run reconciliation: close all VS Code windows, re-open the primary host |
| Repeated `lockAcquired: false` | Stale lock — see "Inspecting / clearing the per-host lock" above |
| `wakeup-daemon-uninstall-failed-on-deactivate` in audit log | Use the manual force-remove for the platform |
| Expand session row shows "no session log available" | The row is a legacy 014/024 record without `correlationId`. Trigger a fresh **Wake up now** to see the new behavior. |
| Model dropdown shows "Default" after Save | Snapshot may not have re-hydrated. Switch to another sub-tab and back; the dropdown should reflect the persisted selection within 1 s. |
| `requestedModel` and `actualModel` differ in JSONL | The settings mirror carried an id outside the closed `WAKEUP_SUPPORTED_MODELS` registry. The runner correctly fell back to `runner-default`; re-Save the model from the dropdown to fix. |
| `session.log` grows past 32 MB | Soft trim runs after each append; size briefly exceeds 32 MB by one block then drops back. If sustained growth, check writer errno (`errorReason: session-log-write-failed:<lower-errno>`) in the JSONL. |
| `session.log` near 128 MB | Hard cap path is normally unreachable. Check for hand-edit corruption (missing `=== wakeup-block ` headers); the writer will emergency-truncate at next append. |

---

## See also

- [specs/014-wake-up/spec.md](../../specs/014-wake-up/spec.md) — functional contract
- [specs/024-wake-up-now-logs/spec.md](../../specs/024-wake-up-now-logs/spec.md) — manual trigger and latest-5 log contract
- [specs/014-wake-up/quickstart.md](../../specs/014-wake-up/quickstart.md) — manual verification
- [docs/security/threat-model.md](../security/threat-model.md) T13 — wake-up workspace context leakage
- [ARCHITECTURE.md](../../ARCHITECTURE.md) "Wake up" — package boundary + audit vocabulary
