# Inspect raw session transcripts

Raw transcripts are per-run local debugging evidence containing the prompt and
backend stdout/stderr without redaction. They are intentionally separate from
the structured `.schegent/audit.log`; inspect them only when the structured
metadata is insufficient and handle every byte as potentially sensitive.
<!-- Source: src/audit/raw-transcript-writer.ts -->
<!-- Source: src/audit/audit-payload.ts -->

## Know whether a file should exist

New runs freeze `schegent.logging.rawTranscriptMode` when the run record is
created. Changing the setting affects later runs, not a run already in flight.
The current values are:

| Mode | During the run | At run finalization |
|---|---|---|
| `always` | appends to `.schegent/sessions/raw-<runId>.log` | retained |
| `errors-only` | stages at `.schegent/sessions/.pending/raw-<runId>.log` | promoted to the final path for `failed`, `canceled`, or `paused`; discarded for `completed` |
| `off` | no transcript or output spool is created | pending and retained transcript paths are discarded if present |

The manifest default and invalid-value fallback for a new run are
`errors-only`. A legacy persisted run with no valid mode migrates to `always`
to preserve its pre-setting behavior, so an old resumed run can retain a
transcript even when the current workspace default is `errors-only`.
<!-- Source: package.json -->
<!-- Source: src/extension.ts -->
<!-- Source: src/services/workflow-run-factory.ts -->
<!-- Source: src/state/workflow-run-migrator.ts -->
<!-- Source: src/audit/raw-transcript-writer.ts -->

File creation is lazy: the writer creates the relevant directory and file on
the first start/end append. An empty `sessions/` directory after a successful
`errors-only` run, or no directory at all in `off` mode, is expected.
<!-- Source: src/audit/raw-transcript-writer.ts -->
<!-- Source: tests/unit/audit/raw-transcript-writer.test.ts -->

Use the same `runId` recorded in the structured audit to locate both possible
paths. A read-only search that covers the retained file and the private pending
directory is:

```bash
find .schegent/sessions -maxdepth 2 -type f \
  -name 'raw-RUN_ID.log' -print
```

Replace `RUN_ID` with the exact identifier before interpreting an absent
result. For an active `errors-only` run, the pending path is the expected one;
do not move it by hand to simulate promotion.
<!-- Source: src/audit/raw-transcript-writer.ts -->
<!-- Source: src/audit/audit-log-writer.ts -->

## Read the block format

Each invocation appends one block to the run's file:

```text
========== SESSION START ==========
Run ID: <runId>
Phase: <phaseId>
Iteration: <number>
Timestamp: <ISO-8601 timestamp>

[PROMPT]
<verbatim prompt>
[STDOUT]
<verbatim stdout>

[STDERR]
<verbatim stderr>

[EXIT_CODE]: <number | null | timeout>
========== SESSION END ==========
```

The exact whitespace around prompt/output depends on the captured bytes, but
the markers above are stable. Multiple Phase attempts and Claude session
compaction calls can append additional blocks to the same run file.
<!-- Source: src/audit/raw-transcript-writer.ts -->
<!-- Source: src/controller/phase-runner.ts -->
<!-- Source: src/controller/session-compactor.ts -->

`[EXIT_CODE]` is `timeout` when `timedOut` is true, otherwise `null` when the
runner supplied no exit code, otherwise the decimal exit code. The `killed`
flag is not serialized separately, so use structured run/audit state to
distinguish cancellation from another no-code termination.
<!-- Source: src/audit/raw-transcript-writer.ts -->

Inspect structure before content:

```bash
rg -n '^(========== SESSION (START|END) ==========|\[PROMPT\]|\[STDOUT\]|\[STDERR\]|\[EXIT_CODE\])' \
  .schegent/sessions/raw-RUN_ID.log
```

Find blocks with an explicit timeout, no exit code, or non-zero exit:

```bash
rg -n '^\[EXIT_CODE\]: (timeout|null|[1-9][0-9]*)$' \
  .schegent/sessions/raw-RUN_ID.log
```

Preview a bounded portion rather than printing an entire potentially large
file into terminal history or captured logs:

```bash
sed -n '1,200p' .schegent/sessions/raw-RUN_ID.log
```

These commands display unredacted content. Do not put a suspected token,
prompt fragment, customer string, or source excerpt directly into a shell
search command where it can become separate command-history evidence.
<!-- Source: src/audit/raw-transcript-writer.ts -->

## Understand full capture and degraded fallback

For each enabled invocation, the runner tees stdout and stderr with stream
backpressure into separate files under an OS-temporary directory named with
the host process ID. The spool directory is requested as mode `0700`; its two
files are created exclusively with mode `0600`. At invocation end, the writer
streams those files into the already-open transcript and removes the spool.
<!-- Source: src/audit/raw-transcript-writer.ts -->
<!-- Source: tests/unit/audit/raw-transcript-writer.test.ts -->

This disk-backed path preserves output that no longer fits in the runner's
bounded parsing buffers. If capture fails, the writer rewinds any partially
copied spool bytes and falls back to the bounded stdout/stderr buffers. It then
marks raw evidence degraded; in that case the transcript can contain only the
buffered head/tail representation rather than every emitted byte.
<!-- Source: src/audit/raw-transcript-writer.ts -->
<!-- Source: tests/unit/audit/raw-transcript-writer.test.ts -->

The first capture in a writer instance scavenges spool directories whose
recorded owner process is no longer alive. It skips the current process and any
PID that still appears alive, and refuses removal when containment under the
configured temporary root cannot be established.
<!-- Source: src/audit/raw-transcript-writer.ts -->

Transcript writes are serialized per run and are best-effort. A write, stream,
cleanup, or containment failure does not abort the workflow; it degrades the
`rawTranscript` evidence sink and produces a sanitized warning such as
`raw transcript write failed for run <id>; workflow continues with degraded raw evidence`.
Common causes are normalized to permission denied, disk full, read-only
filesystem, partial write, stream error, cleanup failure, or generic I/O.
<!-- Source: src/audit/raw-transcript-writer.ts -->
<!-- Source: src/services/evidence-health/evidence-health-monitor.ts -->
<!-- Source: tests/unit/audit/raw-transcript-writer.test.ts -->

If a file stops mid-block or expected middle output is missing, check the
sanitized runtime log and the UI evidence-health projection before concluding
that the backend emitted nothing. Preserve the original file and record its
size, modification time, run ID, and surrounding structural markers.
<!-- Source: src/audit/raw-transcript-writer.ts -->
<!-- Source: src/services/evidence-health/evidence-health-monitor.ts -->

## Retention and cleanup

Retained raw files share the session-artifact retention budget with the same
run's verbose diagnostic tree. The resource-scoped settings are:

| Setting | Default | Allowed range |
|---|---:|---:|
| `schegent.logging.sessionRetentionMaxAgeDays` | 30 days | 1–3650 days |
| `schegent.logging.sessionRetentionMaxBytes` | 536,870,912 bytes (512 MiB) | 1 MiB–10 GiB |

The append-only structured audit is outside `.schegent/sessions` and cannot be
selected by this retention service.
<!-- Source: package.json -->
<!-- Source: src/services/session-retention/session-artifact-retention-service.ts -->

The retention service groups a top-level `raw-<runId>.log` with a top-level
`<runId>/` diagnostic tree, using the group's newest modification time and
combined size. It removes expired unprotected groups first, then removes the
oldest remaining unprotected groups until the total byte budget is met. Runs
whose persisted status is `running` or `paused` are supplied as protected IDs.
<!-- Source: src/services/session-retention/session-artifact-retention-service.ts -->
<!-- Source: src/extension.ts -->
<!-- Source: tests/unit/services/session-retention/session-artifact-retention-service.test.ts -->

A sweep runs during activation, after a non-paused terminal transition, and
when either retention setting changes. Sweeps are serialized and fail soft.
Every sweep emits a structured `session-retention-applied` event with aggregate
counts, bytes, limits, failure count, protected count, and bounded containment
reason codes—never artifact paths or run IDs.
<!-- Source: src/extension.ts -->
<!-- Source: src/activation/run-safety-wiring.ts -->
<!-- Source: src/services/session-retention/session-artifact-retention-service.ts -->
<!-- Source: src/contracts/audit-events.ts -->

Do not rely on a `.pending` file as durable retained evidence: it is an
implementation staging path and may be discarded or renamed at finalization.
Inspect it in place while necessary and let the writer perform the lifecycle
transition.
<!-- Source: src/audit/raw-transcript-writer.ts -->

When an operator removes a Task that has a run ID, task deletion invokes
best-effort cleanup for the final `raw-<runId>.log` and the sibling per-run
diagnostic directory. Cleanup failure does not roll back queue removal, and a
containment refusal leaves the evidence target untouched while returning a
bounded reason.
<!-- Source: src/controller/task-deletion.ts -->
<!-- Source: src/services/session-cleanup/session-cleanup-service.ts -->
<!-- Source: src/services/phase-log/phase-log-path.ts -->

## Security boundary

The transcript writer does not call the sanitizer for prompt, stdout, or
stderr. Tests explicitly require a token-shaped prompt to remain verbatim in
the raw file while the shared logger redacts the same value. Assume a transcript
can contain operator input, workspace source, generated output, credentials,
personal data, and backend diagnostics.
<!-- Source: src/audit/raw-transcript-writer.ts -->
<!-- Source: tests/unit/audit/raw-transcript-writer.test.ts -->

The repository ignores `.schegent/`, and the writer best-effort creates a local
`.schegent/.gitignore` containing `*` without overwriting an existing file.
Directories and transcript files are created with restrictive mode requests,
but these guards do not encrypt the content, securely erase it, or make it
tamper-evident.
<!-- Source: .gitignore -->
<!-- Source: src/audit/schegent-gitignore.ts -->
<!-- Source: src/audit/raw-transcript-writer.ts -->

Raw transcript bytes are classified as a TypeScript-only sink contract with no
generated schema or TypeScript binding for the UI boundary. The sidebar may
project aggregate session-artifact usage and evidence-health state, but it does
not receive raw transcript bytes. There is no Show/Export command for raw
transcripts in the command manifest; open a local file directly when diagnosis
requires it.
<!-- Source: scripts/generate-contract-schemas.mjs -->
<!-- Source: tests/unit/contracts/generated-contracts.test.ts -->
<!-- Source: package.json -->
<!-- Source: src/ui/sidebar/snapshot.ts -->

Keep inspection read-only while a run is active. Do not paste a transcript into
an issue, chat, CI log, or support channel merely because `.gitignore` protects
it from an ordinary commit. Prefer the metadata-only structured audit whenever
the exact unredacted prompt or stream bytes are not necessary.
<!-- Source: src/audit/raw-transcript-writer.ts -->
<!-- Source: src/commands/export-audit.ts -->
