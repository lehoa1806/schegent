# Inspect Raw Session Transcripts

A **raw session transcript** is a per-run, append-only text file that captures
the verbatim prompt sent to the selected backend CLI and the verbatim
stdout/stderr/exit code returned. It is intended for **local developer
debugging only**, parallel to and distinct from the structured
`.schegent/audit.log`.

## File location

```text
<workspaceRoot>/.schegent/sessions/raw-<runId>.log
```

One file per workflow run. The `<runId>` matches the `runId` (and
`correlationId`) seen in `.schegent/audit.log` entries, so the two records can
be cross-referenced.

## File format

Each LLM invocation produces one block:

```text
========== SESSION START ==========
Run ID: <runId>
Phase: <phase>
Iteration: <n>
Timestamp: <ISO-8601>

[PROMPT]
<verbatim prompt>

[STDOUT]
<verbatim stdout>

[STDERR]
<verbatim stderr>

[EXIT_CODE]: <numeric | null | timeout>
========== SESSION END ==========
```

`[EXIT_CODE]` value rules:

| Outcome | Value |
|---|---|
| Normal exit | numeric (e.g., `0`, `1`) |
| Process killed without exit code (cancellation) | `null` |
| Timeout | `timeout` |

## Lifecycle

- **Creation**: lazy. The directory and file are created on first write of a
  given `runId`.
- **Append-only**: every invocation appends a new block; nothing is ever
  overwritten or rewritten.
- **Bounded retention**: raw transcripts are grouped with the same run's
  session diagnostics and pruned only after the run is inactive. The default
  limits are 30 days and 512 MiB across session artifacts; configure them with
  `schegent.logging.sessionRetentionMaxAgeDays` and
  `schegent.logging.sessionRetentionMaxBytes`.
- **Best-effort**: I/O failures (read-only FS, permission, full disk) are
  caught and surfaced once per `runId` to `.schegent/audit.log` as a warn-level
  log line. They never abort the workflow run.
- **Bounded-memory capture**: stdout and stderr are teed with stream
  backpressure into private mode-`0600` files under the OS-managed temporary
  directory, then streamed into the append-only transcript and removed at
  invocation end. Abandoned spools are scavenged after their owner process is
  gone. Sink drain time is excluded from the CLI idle timeout. The transcript
  does not inherit the parser buffer's head/tail truncation.

## Quick inspection commands

Show every prompt sent during a run:

```bash
awk '/\[PROMPT\]/,/^$/' .schegent/sessions/raw-<runId>.log
```

Show only failures (non-zero or non-`0` exit codes):

```bash
grep -A2 'EXIT_CODE' .schegent/sessions/raw-<runId>.log | grep -B1 -v 'EXIT_CODE.*: 0$'
```

List all transcripts:

```bash
ls -1 .schegent/sessions/
```

## Security boundary

These transcripts are **intentionally unredacted**. They may contain anything
the user pasted into a feature description, anything the LLM emitted, and
anything the CLI printed to stderr — including secrets if a user pasted them.

The structured audit log at `.schegent/audit.log` remains the canonical,
sanitized, exfil-safe record. The raw transcript is **comparable to a
developer's terminal scrollback**: useful for local diagnosis, never to be
shared, copied, or committed.

Guards in place:

| Guard | Where |
|---|---|
| `.schegent/` is in `.gitignore` | [.gitignore](../../.gitignore) |
| Never exposed via webview / sidebar / dashboard / output channel | by design (no IPC plumbing reads the file) |
| Never sanitized — raw is raw | [src/audit/raw-transcript-writer.ts](../../src/audit/raw-transcript-writer.ts) |

## Parser-buffer truncation flag

Each backend caps its in-memory parsing buffers at 4 MiB, retaining an ordered
head and rolling tail. The matching `phase-end` audit entry carries
`stdoutTruncated: true` and/or `stderrTruncated: true` when this occurs; the
flags are omitted on the common non-truncated path. A result that would
otherwise be clean fails closed as the terminal
`output-truncated-unclassifiable` failure, because fatal evidence could have
appeared in the discarded middle. The raw transcript remains verbatim and is
the supported place to inspect those omitted bytes.

## When to inspect

Reach for the raw transcript when:

- An LLM invocation looped or returned malformed JSON and you need to see the
  exact prompt text byte-for-byte.
- A clarify-phase question seems unrelated to the spec and you want to confirm
  what the model actually saw.
- A run errored mid-flight and the structured audit log shows only `failure`
  with no usable payload — the raw stderr is in the transcript.

For every other case, prefer `.schegent/audit.log`. It is structured, redacted,
and indexed by `correlationId`.
