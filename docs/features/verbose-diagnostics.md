# Verbose Diagnostics

Verbose diagnostics is the operator-opt-in unredacted capture of the Claude CLI's full debug output. It exists for the cases where the sanitized audit log and the sanitized phase log feed do not tell you enough — and you need to see the raw bytes.

## When to use it

- A phase is failing in a way you cannot explain from the audit log.
- A tool call argument is being malformed and you suspect the sanitizer is masking the problem.
- You want to capture the exact CLI protocol stream for a bug report to Anthropic.
- A regression appeared in a CLI upgrade and you want a precise replay.

For typical operation, **leave it off**. The redacted sinks are sufficient for the day-to-day, and the diagnostic capture writes unredacted bytes that you have to manage.

## Enabling it

Set the setting:

```jsonc
{ "schegent.logging.verbose": true }
```

Or toggle **Verbose diagnostics** in the sidebar settings panel.

When verbose is `true`, the host adds three flags to every Claude CLI invocation:

- `--debug-file <path>` — full CLI debug payload to a file.
- `--output-format stream-json` — the stream-json event stream.
- `--verbose` — verbose stderr.

The CLI then writes the corresponding outputs, and the host tees them to per-invocation files under `.schegent/sessions/<runId>/diagnostics/`.

## What gets captured

For each phase invocation, the host writes three files to a directory keyed by run / pipeline / phase / iteration:

```text
<workspaceRoot>/.schegent/sessions/<runId>/diagnostics/<pipelineId>/<phaseId>/iter-<N>/
├── debug.json        # Full CLI debug payload
├── stream.jsonl      # Stream-json events, one per line
└── verbose.log       # The --verbose stderr capture
```

If a phase loops, each iteration gets its own `iter-<N>/` subdirectory.

## What does *not* get captured

- **Other phases** in the same run, until they too run with verbose enabled.
- **Past phases** that already completed before you enabled verbose.

The setting is re-read at the entry of every phase invocation, so toggling it on mid-run captures the *next* phase forward, not the in-flight one.

## Sanitization

**The verbose diagnostic files are intentionally unredacted.** They are an operator opt-in for deep troubleshooting; the redaction set is not applied. This is the entire point — the files exist precisely because the sanitizer might hide the field you need.

Mitigations against accidental disclosure:

- The files are **local-only** — written to `.schegent/sessions/...`. The directory's `.gitignore` blocks itself, and the recommended workspace `.gitignore` blocks `.schegent/`.
- The host **never reads them back** through the IPC pipeline. The webview cannot request their contents.
- The structured audit log **never references them by path** — only by selection tuple.
- They are off by default; you opt in explicitly.

If you cannot tolerate unredacted bytes on disk, do not enable verbose diagnostics. The default-off posture is the safer choice for most operators.

## Mid-run toggling

The verbose flag is **not cached**. The host re-reads it at the entry of every phase invocation via the `VerboseDiagnosticsAccessor`. Toggling it from the sidebar takes effect on the *next* phase boundary; the in-flight phase is unaffected.

This makes verbose useful for capturing a specific problematic phase: set a breakpoint before the phase, enable verbose, resume, capture the diagnostic files, disable verbose again.

## Cleanup

Diagnostic files do not rotate individually. Schegent groups them with the
run's raw transcript and prunes complete inactive-run groups using the
configured session-artifact age and byte budgets (30 days and 512 MiB by
default). Running and paused runs are protected.

To clean them up:

- **Per task** — right-click a history task → **Remove task** → confirm "Yes, remove session tree". The diagnostic files under that runId's session tree are removed best-effort.
- **All diagnostics** — manual: `rm -rf <workspaceRoot>/.schegent/sessions/*/diagnostics/`.
- **Automatic policy** — adjust `schegent.logging.sessionRetentionMaxAgeDays`
  and `schegent.logging.sessionRetentionMaxBytes` in Settings. The Settings
  panel also reports current retained bytes and sweep failures.

The structured audit log is never affected by diagnostic cleanup.

## Worked example: capturing one phase

You want to capture the verbose output of `speckit-implement` for a specific failing run.

1. The failing run is in-flight, paused or running.
2. If running, click **Pause** to stop at the next phase boundary.
3. Set a breakpoint on `speckit-implement` (so the run pauses *before* it starts). See [Phase Breakpoints](phase-breakpoints.md).
4. Toggle **Verbose diagnostics** on in the settings panel.
5. Click **Resume**.
6. The breakpoint fires, then `speckit-implement` runs with verbose flags.
7. After the phase completes, the three diagnostic files appear under `.schegent/sessions/<runId>/diagnostics/speckit-new-feature/speckit-implement/iter-1/`.
8. Toggle verbose **off** so subsequent phases run normally.

You can then open the files in your editor or attach them to a bug report.

## Audit-log trace

Verbose diagnostics do not have their own audit events — the diagnostic files are a CLI capture, not an audit event. However:

- The `phase-start` event records the phase's pipeline / phase / iteration tuple. You can correlate with the diagnostic directory by walking the tuple.
- The `cli-invocation` event records the argv composition; with verbose enabled you will see `--debug-file`, `--output-format stream-json`, `--verbose` in the args.

The audit log records the *intent* and *outcome*; the diagnostic files record the *content*.

## Limits and gotchas

- **Disk usage.** A long `speckit-implement` phase with verbose enabled can produce megabytes of debug output. Keep an eye on `.schegent/sessions/` size.
- **No git.** The diagnostic files are intentionally unredacted; do **not** commit them. Your `.gitignore` should prevent it, but be cautious when zipping the workspace.
- **No telemetry.** The verbose capture is local. Nothing leaves your machine.
- **Mid-iteration toggle.** A loop phase that toggles verbose mid-iteration captures the iterations that follow, not the in-flight iteration.

The next feature is [Fatal Signatures](fatal-signatures.md).
