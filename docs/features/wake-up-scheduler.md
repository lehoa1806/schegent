# Wake-up Scheduler

> Keep your Claude allocation warm so the first prompt of the day doesn't burn 30 seconds priming the rolling 5-hour window.

## Feature Overview

The Wake-up Scheduler is a background task that periodically issues a tiny, single-token request to the Claude CLI on your behalf, even when VS Code is closed. The request runs at the operating-system level (launchd on macOS, Task Scheduler on Windows, systemd-user or cron on Linux) inside an isolated temporary directory that has no access to your workspace files.

You configure it once from the Schegent Settings panel: pick a daily time or a periodic interval, optionally pin a specific Claude model, and click **Save**. The extension installs the OS scheduler entry for you. Each firing — scheduled or manual — is captured in an append-only session log that you can expand row-by-row inside the Schegent sidebar.

## Why Use This? (Core Value)

Anthropic's API enforces a rolling 5-hour usage allocation. The first invocation after a quiet period pays a one-time warm-up cost: the platform allocates a fresh window, your CLI authenticates, and any model-routing tier is established. For interactive sessions this is invisible; for **autonomous Schegent pipelines that fire late at night or first thing in the morning**, it shows up as either a slow first phase or — worse — a token-exhaustion failure right at the moment you wanted automation to take over.

Wake-up solves three concrete problems:

- **Cold-start latency.** Your 06:30 stand-up review against a freshly authored spec hits a warm window instead of paying the prime-the-pump cost on your time.
- **Allocation alignment.** A pre-dawn ping at 04:00 means a long unattended pipeline kicked off at 05:00 starts inside an open window rather than racing the rate limiter.
- **Drift detection.** Each firing is logged with the model that was actually used, what the CLI returned, and any subprocess errors. If your CLI install silently drifts (expired auth, missing binary, network outage), the next morning's log makes that visible — long before a real pipeline run fails.

Wake-up is **not** a benchmark, a health check, or a heartbeat that other systems should consume. It is a low-cost priming hook for the operator running this extension.

## Conceptual Understanding (How it Works)

### The two scheduling modes

You pick exactly one trigger style:

- **Chronological** — fires once per day at a fixed local time. Best when you have a predictable daily routine ("I start work around 08:00, so prime at 07:45").
- **Periodic** — fires every *N* minutes or hours. Best for round-the-clock workflows ("Every 4h" keeps a window perpetually warm without a single big firing each day).

You cannot combine modes. Switching modes and saving rebuilds the OS scheduler entry from scratch — there are never two competing daemons running.

### Where the wake-up actually runs

When the OS scheduler fires, it spawns a small headless process bundled with the extension. That process:

1. Reads your saved wake-up settings.
2. Loads the **workspace-roots snapshot** the extension persisted the last time you saved settings.
3. Creates an ephemeral scratch directory outside any workspace root.
4. Verifies the scratch directory is not a child of any recorded workspace root. If it is — for any reason — the runner aborts and writes a failure record. **No Claude subprocess is launched.**
5. Scrubs the environment down to a strict allowlist (`PATH`, `HOME`, `LANG`, locale `LC_*`, `TMPDIR`, etc.) so neither workspace-specific variables nor secrets leak into the priming invocation.
6. Spawns `claude` with a single tiny prompt and the model you selected (or no `--model` flag at all if you chose "Default").
7. Captures stdout and stderr into a 64 KB in-memory ring buffer, applies the same redaction patterns the rest of the extension uses, and appends the result as a single labelled **block** to a session log file.

A watchdog terminates the subprocess after 60 seconds.

### Sessions, blocks, and what survives a restart

Every firing writes a single block to `<VS Code global storage>/wakeup/session.log`:

```text
=== wakeup-block 2026-05-17T04:00:01Z id=8c2e... trigger=scheduled model=claude-sonnet-4-6 status=success ===
OUT: Hello! How can I help you today?
ERR:
=== wakeup-block ... ===
```

The block header records the invocation's correlation ID, the trigger source (`scheduled` or `manual`), the actual model used, and the outcome. When you expand a row in the Schegent sidebar, the host reads back the block for that correlation ID — sanitized again as defense in depth — and projects up to 32 KB into the UI. If the block on disk is larger, you see a "see full file" affordance that opens `session.log` in your OS file manager.

The log grows by appends only. Once it crosses the 32 MB soft cap, the oldest *complete* blocks are trimmed from the head. A 128 MB hard cap exists as an emergency floor in case the file is hand-edited and the block scanner can no longer find boundaries.

### Single source of truth: the primary host

Wake-up settings are stored at user (global) scope, so they apply across all your VS Code windows. The save command, the "Wake up now" command, and the log-reading commands are all gated to the **primary** VS Code host. If you have multiple VS Code windows open against different projects, only one will own the wake-up configuration. The others render the panel read-only.

This is how the extension prevents a secondary window from rewriting your OS scheduler entry mid-session without your knowledge.

## Configuration & Parameters

### VS Code settings (editable in `settings.json` or the Settings UI)

| Name & Type | Default | Description |
|---|---|---|
| `schegent.wakeUp.enabled` [boolean] | `false` | Master switch. When `true`, saving installs the OS scheduler entry; when `false`, saving removes it. |
| `schegent.wakeUp.schedulerType` [string enum: `"chronological"` \| `"periodic"`] | `"chronological"` | Selects which of the two trigger-style fields below applies. |
| `schegent.wakeUp.chronologicalTime` [string, `HH:MM` 24-hour] | `"04:00"` | Daily fire time in your local timezone. Honors daylight-saving transitions. Used only when `schedulerType` is `"chronological"`. |
| `schegent.wakeUp.periodicInterval` [string, `"Every Nm"` or `"Every Nh"`] | `"Every 4h"` | Periodic interval. Minimum granularity is one minute (`"Every 1m"`). Intervals under 5 hours are accepted but surface a non-blocking advisory in the Settings panel because they may waste tokens within an unreset rolling window. Used only when `schedulerType` is `"periodic"`. |

All four are scoped `application` (user/global), not workspace, and never per-folder.

### Setting managed only from the Schegent sidebar

| Name & Type | Default | Description |
|---|---|---|
| `schegent.wakeUp.model` [string enum] | `"runner-default"` | Pinned Claude model for every wake-up invocation. Allowed values: `"claude-opus-4-7"`, `"claude-opus-4-8"`, `"claude-sonnet-4-6"`, `"claude-haiku-4-6"`, or the sentinel `"runner-default"` (no `--model` flag — the CLI picks its own default). Saved through the sidebar Settings panel, not the Settings UI. Unsupported values entered manually into `settings.json` are coerced to the sentinel on read and rejected on save. |

### Sidebar buttons

| Action | What it does |
|---|---|
| **Save** | Validates every field atomically, installs/updates/removes the OS scheduler entry, persists the workspace-roots snapshot used for cwd isolation, and records the change as an audit event. Save is **transactional** — if validation fails, nothing is written. |
| **Wake up now** | Fires the wake-up runner immediately with your currently saved model and settings. Useful for testing your configuration without waiting for the next scheduled firing. |
| **Reveal log** | Opens `session.log` in your operating system's file manager (Finder / Explorer / your `xdg-open` handler). |

## Practical Examples (How-To)

### Example 1 — Prime the window before a 07:00 stand-up

You want your morning review pipeline to find a warm allocation when you kick it off at 07:00. Set a chronological wake-up at 06:30 using whichever model your morning pipeline uses.

In your user `settings.json`:

```jsonc
{
  "schegent.wakeUp.enabled": true,
  "schegent.wakeUp.schedulerType": "chronological",
  "schegent.wakeUp.chronologicalTime": "06:30"
}
```

Then open the Schegent sidebar, expand **Wake up**, choose **Claude Sonnet 4.6** in the model dropdown, and click **Save**.

The next morning, expand the Wake-up log card in the sidebar. You should see a row dated today at 06:30 with `model=claude-sonnet-4-6` and `status=success`.

### Example 2 — Continuous priming for an unattended overnight pipeline

You enqueue a long Spec Driven Development workflow feature run before leaving for the day and want every 4-hour rolling window to stay warm until you check in the next morning.

In your user `settings.json`:

```jsonc
{
  "schegent.wakeUp.enabled": true,
  "schegent.wakeUp.schedulerType": "periodic",
  "schegent.wakeUp.periodicInterval": "Every 4h"
}
```

Save through the sidebar. The runner will now fire roughly every 4 hours starting from the moment you saved (`05:42`, `09:42`, `13:42`, …). Tomorrow morning, the log shows four or five rows — one per firing — each tagged `trigger=scheduled`.

If you want the cheapest possible priming, pick **Claude Haiku 4.6** in the model dropdown — the priming token cost is dominated by tier setup, so the smaller model materially reduces token spend across many firings.

### Example 3 — Smoke-test a fresh install

You just installed Schegent on a new machine and want to verify the CLI is wired correctly before trusting an automated nightly run.

1. In the sidebar, set **Enable** to off (for now — you don't want a scheduled entry yet).
2. Pick a model in the dropdown.
3. Click **Save**, then immediately click **Wake up now**.
4. Click **Reveal log** and confirm a new block appeared at the tail of `session.log` with `trigger=manual` and `status=success`.

If the block is missing, expand the Wake-up log card in the sidebar to see the corresponding failure row — every failure is captured even when no subprocess output is produced. Once the smoke test passes, set **Enable** to on and pick your real schedule.

## Edge Cases & Limitations

### Things wake-up will not do

- **It will not run inside any of your workspaces.** The runner snapshots all open workspace roots at save time and refuses to spawn the Claude subprocess if its temporary working directory turns out to be a child of any recorded root. This is a hard, audited stop.
- **It will not pass your VS Code environment to the subprocess.** Variables starting with `VSCODE_`, `WORKSPACE_`, or `SCHEGENT_` are dropped, as are anything containing `TOKEN`, `SECRET`, `KEY`, or `PASSWORD`. Only a strict allowlist (`PATH`, `HOME`, `LANG`, locale `LC_*`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`, `TEMP`, `TMP`) survives.
- **It will not write paths into the audit log.** The structured audit event for each firing records the correlation ID, the requested model, and the actual model used — never the session-log path, never workspace roots, never byte counters.
- **It will not run more than one wake-up at a time.** If a previous firing is still alive when the next fires, the new firing skips. Stale locks older than 120 seconds are reclaimed automatically.

### Rate, size, and timing limits

- **Minimum periodic interval:** 1 minute. Save is rejected for shorter values.
- **Recommended periodic interval:** 5 hours or more. Anything below surfaces a non-blocking warning; the API allocation resets every 5 hours, so faster firings tend to spend tokens without resetting the window.
- **Subprocess timeout:** 60 seconds, followed by a 5-second graceful shutdown grace period, then SIGKILL.
- **Per-invocation capture buffer:** 64 KB. Subprocess output longer than that is truncated from the head and the block is annotated `sessionCaptureTruncated: true`.
- **In-app log view:** at most 32 KB per block. Larger blocks surface a "see full file" link.
- **On-disk log retention:** soft cap 32 MB, hard cap 128 MB. Trims happen block-by-block from the oldest end.

### Operating system caveats

- **Sleeping machines.** Wake-up does not wake the hardware. If your laptop is closed at the scheduled time, the firing is missed entirely; the OS scheduler will catch up at the next interval, depending on platform behavior. For laptops, consider pairing chronological wake-up with a time you know the machine is awake.
- **launchd quirks on macOS.** Permission to install a `LaunchAgent` is granted to your user automatically — no admin password — but corporate MDM profiles can block the install. The failure surfaces as `wakeup-daemon-install-failed` in the audit log.
- **cron fallback on Linux.** If your distribution lacks `systemctl --user`, the extension falls back to cron. Cron does not understand chronological-vs-periodic semantics natively; the extension translates both to a single `crontab` line.
- **Multi-window VS Code.** Only the primary host can save settings or trigger "Wake up now". The other windows show read-only state and route IPC rejections cleanly.

## Troubleshooting

### "Save" is greyed out

The Settings panel only enables **Save** when every field passes validation. Common causes:

- **`chronologicalTime` is not `HH:MM`.** Use 24-hour form with leading zeroes (`04:00`, not `4:00`).
- **`periodicInterval` is malformed.** It must match `Every Nm` or `Every Nh` exactly (`Every 4h`, `Every 15m`). A bare number, a different unit, or a multiplier (`Every 1.5h`) is rejected.
- **You're in a secondary VS Code window.** Open the original window you started Schegent from, or close the others and reopen the extension.

### A scheduled firing never appeared in the log

Check, in order:

1. **Was the OS scheduler actually installed?** Expand the **Wake up** card; the panel reports the daemon state. If it says "uninstalled" even though `enabled` is true, check the audit log for a `wakeup-daemon-install-failed` event. The accompanying error message points at the underlying OS error.
2. **Was the machine awake?** Wake-up does not wake the device. Check whether the scheduled time falls inside your machine's sleep window.
3. **Did the firing skip because another was active?** Look for a JSONL record with `skipped: true` and `errorReason: 'lock-held'`. This is normal if a previous firing hung close to its 60-second watchdog.

### "Wake up now" succeeds but the log shows `claude-spawn-failed`

The `claude` binary is not on the runner's `PATH`. Because the runner uses a scrubbed environment, it sees only the `PATH` your shell exports at the moment VS Code launched.

- Confirm `which claude` works in a fresh terminal.
- If `claude` is installed under `~/.local/bin` or similar, ensure that path is in your login shell's `PATH` (not just `~/.bashrc`).
- After updating your shell config, restart VS Code so the extension picks up the new environment.

### The block header says `model=runner-default` even though I picked Claude Opus 4.7

The model dropdown in the sidebar persists to `schegent.wakeUp.model`. If you instead edited `settings.json` and typed a value that is not in the supported list, the read-time coercion collapses it to `runner-default`. Open the sidebar dropdown and pick the model again — the save path validates strictly and will surface `invalid-model` if you try to enter an unsupported value.

### The session log is missing or empty

If you deleted `session.log` from disk while no wake-up was running, the next firing recreates it from scratch — no recovery needed.

If the file exists but no blocks render in the sidebar, **Reveal log** still works: open the file in your OS file manager and inspect it. A common cause is that every wake-up so far has failed before the Claude subprocess produced output (e.g., `claude-spawn-failed`), in which case the failure rows are in the audit log rather than the session log.

### A failure row says `cwd-inside-workspace-aborted`

This means the temporary working directory the runner created turned out to be inside one of your workspace roots — typically because `TMPDIR` points at a location under your project. Resolve by either:

- Unsetting the workspace-scoped `TMPDIR` so the runner falls back to the system default, or
- Moving your workspace out of any directory that contains a temp-dir-named subdirectory.

After fixing, click **Wake up now** to confirm the next firing succeeds. This is a *defense-in-depth* abort — your workspace is never touched by the runner — so seeing it once is a signal that your environment, not the extension, needs attention.
