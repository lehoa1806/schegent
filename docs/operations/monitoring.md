# Monitoring a Running Pipeline

Once a pipeline is in-flight, you have multiple windows into what it is doing. This page walks through which sink to use for which question, with concrete examples.

## The four windows

| Window | What it shows | When to use |
|---|---|---|
| **Sidebar phase log feed** | Live, sanitized projection of the CLI stream | "What is the current phase doing right now?" |
| **Dashboard** | The phase log feed alongside the runtime debug log | Multi-pane supervision; long-running runs |
| **Audit log** (`.schegent/audit.log`) | Structured, sanitized, append-only JSONL | "What happened during phase X?" and historical queries |
| **Raw transcript** (`.schegent/sessions/raw-<runId>.log`) | Unredacted CLI scrollback | Deep debugging when the sanitized sinks hide the field you need |

Plus two optional windows:

| Window | What it shows | When to use |
|---|---|---|
| **Verbose diagnostics** (opt-in) | Per-invocation unredacted CLI capture | "What was the exact CLI protocol for this phase?" |
| **Runtime log** (`.schegent/syslog`) | Host-side internal log mirror | "What was the host doing internally during X?" |

## "What is the pipeline doing right now?"

Open the sidebar. The in-flight task shows:

- The current phase id.
- The elapsed time.
- A PID badge.
- The most recent activity in the phase log feed.

The feed is a one-line-per-event rolling view. If you see something concerning, expand the tool call to see its arguments.

For a roomier view, click **Open Dashboard**.

## "Is it stuck?"

A stuck phase typically shows:

- The PID badge is present (subprocess is alive).
- The elapsed time keeps growing.
- The phase log feed stopped scrolling some time ago.

Check the dashboard's runtime debug log alongside the feed. The host's monitor emits `monitor-stall` records after a configured period without stdout. If you see one, the host has noticed the stall.

If you do not see a stall record but the feed is quiet, the phase is genuinely running a long tool call (e.g., a `Bash` command). The next event will arrive when the command completes.

## "Why did it fail?"

When a phase ends in failure, the audit log records a `phase-end` event with `outcome: failure` and a `cause` discriminator. The most useful causes:

- `nonzero-exit` — the CLI exited non-zero. Inspect the raw transcript for stderr.
- `fatal-signature` — a fatal signature matched. The previous `fatal-signature-matched` event tells you which signature and where.
- `timeout` — the watchdog killed the phase. The phase exceeded `schegent.invocation.timeoutSeconds`.
- `rate_limit` — Anthropic returned a rate-limit response. A `retry-scheduled` event should follow.
- `canceled` — the operator canceled.

Search the audit log:

```bash
jq 'select(.eventType == "phase-end" and .outcome == "failure")' .schegent/audit.log
```

## "What did the phase write?"

The audit log has `file-write` events. They include sanitized metadata about what was written.

For path-level detail, the raw transcript has the `Write` and `Edit` tool call arguments verbatim. Open `.schegent/sessions/raw-<runId>.log` and search for `Write` or `Edit`.

## "What was the prompt for the phase?"

The audit log records the phase id and pipeline id but not the verbatim prompt (the prompt is composed from the instruction + dynamic context at invocation time).

For the verbatim prompt, look at:

- The raw transcript — the first few lines of each invocation show the CLI's prompt receipt.
- The verbose diagnostic capture (`stream.jsonl`) if verbose was enabled for that phase.

## Watching the audit log in real time

A useful workflow when a run is misbehaving:

```bash
tail -f .schegent/audit.log | jq -c 'select(.outcome != "info")'
```

This shows you only success/failure events as they arrive. Add filters for specific event types:

```bash
tail -f .schegent/audit.log | jq -c 'select(.eventType | startswith("retry"))'
```

## Watching the runtime log

The runtime log mirrors the Output channel:

```bash
tail -f .schegent/syslog
```

Filter by severity:

```bash
tail -f .schegent/syslog | grep -E "^(WARN|ERROR)"
```

## Watching the raw transcript

The raw transcript is the unredacted CLI scrollback. The host writes it line-by-line as the CLI emits:

```bash
tail -f .schegent/sessions/raw-<runId>.log
```

Replace `<runId>` with the UUID for the run; you find it in the audit log or the sidebar's run detail.

## "How many tokens has this run consumed?"

The audit log does not record token usage directly. The CLI does report it on completion, but the host does not parse it into a structured field.

You can grep the raw transcript for the CLI's usage summary. Or, if verbose diagnostics are enabled, the `stream.jsonl` has structured token usage records per turn.

## "Is the wake-up scheduler doing its job?"

Two windows:

- The audit log records every `wakeup-runner-invocation` event with `outcome` and timing.
- The wake-up session log at `<globalStorageUri>/wakeup/session.log` shows the priming prompt and response.

To survey wake-up outcomes:

```bash
jq -c 'select(.eventType == "wakeup-runner-invocation") | {timestamp, outcome, cause}' .schegent/audit.log
```

## Long-running supervision

For a multi-hour run:

1. **Open the dashboard.** Roomier feed, runtime log side-by-side.
2. **Set a breakpoint at `finalize`** if you want to inspect before verification.
3. **Enable verbose diagnostics** for `speckit-implement` if you anticipate needing the deep capture.
4. **Tail the audit log** in a terminal for an at-a-glance health check.

You do not have to stare at the run continuously. The audit log preserves everything; you can come back hours later and reconstruct what happened.

## Pre-flight monitoring before enqueue

Before you submit a task:

- Verify the CLI badge is green (CLI ready).
- Check whether the queue is currently paused.
- Check whether another task is already in-flight (you can enqueue, but it will wait).
- Look at the most recent terminal task in history. If it failed, understand why before adding more work.

A small amount of pre-flight prevents avoidable confusion later.

## Post-mortem after a run

After a run terminates:

1. **Read `phase-end` events** in order. Each phase's outcome and duration tells you the shape of the run.
2. **Check for `warning` / `error` lifecycle events** — non-fatal issues that did not abort the run but are worth knowing about.
3. **If failed, find the `fatal-signature-matched` or the `monitor-invocation-failed`** to see exactly what went wrong.
4. **If retried, walk the `retry-scheduled` / `retry-recovered` chain** to see how long the recovery took.

The audit log is the canonical record. Everything you need is there; nothing else is required.

The next operations page is [Intervention Playbook](intervention.md).
