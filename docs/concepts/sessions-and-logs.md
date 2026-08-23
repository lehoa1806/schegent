# Sessions, logs, and local evidence

Schegent uses the word *session* for several related but different things. It
also writes several local files with different privacy and durability
properties. Keeping those meanings separate makes retry behavior and incident
diagnosis much easier to reason about.

## Four meanings of session

| Term | Lifetime | Purpose |
| --- | --- | --- |
| Run session | While one queue has a non-terminal Run | In-memory bundle containing that queue's driver and continuation gate. |
| Backend session | Across compatible backend invocations | Provider-owned conversation identifier used for retry/resume or prompt-cache reuse. |
| Session artifacts | Until cleanup or retention removes them | Workspace files containing raw transcripts and optional verbose diagnostics. |
| Phase-log tail session | While the UI watches one phase log | Ephemeral host-to-webview subscription identified by a generated UUID. |

<!-- Source: src/controller/run-session.ts -->
<!-- Source: src/state/workflow-run.ts -->
<!-- Source: src/services/phase-log/phase-log-tail-registry.ts -->

### Run sessions

The controller keeps a `RunSessionRegistry` keyed by queue ID. A run session
owns one `RunDriver` and one `IsContinueGate`, so concurrent queues cannot
consume each other's cancellation state or continuation request. Re-acquiring
the same queue returns the same session. A session is removed only after its
driver is idle and its Run is absent or terminal; a paused Run deliberately
keeps its session and concurrency slot.

<!-- Source: src/controller/run-session.ts -->

Run sessions are process memory, not files under `.schegent/sessions/`. The
shared state store, audit writer, transcript writer, history recorder, lease
manager, and workspace lock remain outside this per-queue object.

<!-- Source: src/controller/run-session.ts -->

### Backend sessions

When stream JSON contains a non-empty `session_id`, `conversation_id`, or
`conversationId` of at most 256 characters, Schegent can persist that backend
conversation identity on the Run. IDs may be top-level or nested under
`conversation` or `session`. Plain-text output, malformed JSON, and invalid IDs
produce no identity.

<!-- Source: src/parser/session-id-extractor.ts -->
<!-- Source: tests/unit/parser/session-id-extractor.test.ts -->

A persisted ID is reusable only when its recorded backend kind matches the
effective backend for the next invocation. `isContinue` means continuing an
interrupted conversation; `sessionReuse` means starting later work in the same
provider session for cache reuse. If ownership cannot be proven, continuation
and reuse both fail closed to a fresh backend session, while an operator's
resume prompt can still be sent safely.

<!-- Source: src/services/session-dispatch-policy.ts -->
<!-- Source: tests/unit/services/run-driver-backend-session.test.ts -->

## Local evidence map

For a workspace-backed run, the main sinks are:

| Sink | Default location | Content posture | Bound |
| --- | --- | --- | --- |
| Structured audit | `.schegent/audit.log` | Projected and sanitized JSONL metadata | Rotates by configured size or age; archives are retained by count and age. |
| Raw transcript | `.schegent/sessions/raw-<runId>.log` | Verbatim, unredacted prompt/stdout/stderr/exit status | Per-run retention policy plus session-artifact age/byte sweep. |
| Verbose diagnostics | `.schegent/sessions/<runId>/diagnostics/<pipelineId>/<phaseId>/iter-<N>/` | Opt-in, unredacted debug and stream files | Session-artifact age/byte sweep. |
| Runtime log | `.schegent/syslog` by default | Sanitized formatted host log | Configurable byte threshold and generation count. |
| CLI transport | `.schegent/cli-transport.log` | Sanitized but may contain workspace paths | Fixed 5 MiB live generation plus three rotated generations. |
| Metrics rollup | `.schegent/metrics-rollup.jsonl` | Typed terminal-run counters; no free text | Append-only and intentionally not pruned. |
| Recovery checkpoints | `<globalStorage>/checkpoints/<runId>/` | Private Git patches and metadata; may contain source or secrets | 14-day age, 256 MiB total, and a ten-recent-run size floor. |

<!-- Source: src/audit/audit-log-writer.ts -->
<!-- Source: src/audit/raw-transcript-writer.ts -->
<!-- Source: src/audit/verbose-diagnostic-path.ts -->
<!-- Source: src/lib/runtime-log/runtime-log-path.ts -->
<!-- Source: src/monitor/cli-transport-sink.ts -->
<!-- Source: src/metrics/metrics-rollup-writer.ts -->
<!-- Source: src/services/run-checkpoint-retention.ts -->

These sinks are not interchangeable. The audit log is structured evidence;
the raw and verbose files preserve diagnostic bytes; the runtime and transport
logs help operators follow execution; the metrics rollup preserves cumulative
counts after audit rotation; and checkpoints are manual recovery material.

<!-- Source: src/contracts/audit-events.ts -->
<!-- Source: src/metrics/terminal-run-rollup-recorder.ts -->
<!-- Source: src/services/run-checkpoint-service.ts -->

## Raw transcripts

Raw transcripts are intentionally unredacted. For each invocation they record
a start block containing the phase, iteration, and prompt, followed by stdout,
stderr, exit information, and an end marker. Disk-backed temporary spools use
mode `0600` and preserve complete stdout/stderr without requiring unbounded
memory; the final transcript is also opened with mode `0600`. Failures are
best-effort warnings and do not fail the Run.

<!-- Source: src/audit/raw-transcript-writer.ts -->
<!-- Source: tests/unit/audit/raw-transcript-writer.test.ts -->

`schegent.logging.rawTranscriptMode` is frozen onto each new Run. Its values are:

| Value | Behavior |
| --- | --- |
| `errors-only` | Default. Write under `.schegent/sessions/.pending/`, discard on completion, and promote to `raw-<runId>.log` for a failed, canceled, or paused Run. |
| `always` | Write and retain `raw-<runId>.log` for every outcome. |
| `off` | Do not create or retain a raw transcript. |

<!-- Source: src/config/settings-schema.ts -->
<!-- Source: src/services/workflow-run-factory.ts -->
<!-- Source: src/audit/raw-transcript-writer.ts -->

The mode applies to new Runs because it is part of the frozen Run record. A
later setting change does not retroactively change an in-flight Run's policy.
Legacy records without the field migrate conservatively to `always`.

<!-- Source: src/state/workflow-run.ts -->
<!-- Source: src/state/workflow-run-migrator.ts -->

## Verbose diagnostics and phase-log display

With `schegent.logging.verbose` enabled, each invocation gets a validated
diagnostic target:

```text
.schegent/sessions/<runId>/diagnostics/<pipelineId>/<phaseId>/iter-<N>/
├── debug.json
├── stream.jsonl
└── verbose.log
```

The files are unredacted and best-effort. Run, Pipeline, and Phase identifiers
must match the safe path-segment grammar, and the composed directory must stay
under `.schegent/sessions/`. The setting is read when each phase invocation
starts, so a toggle affects the next invocation rather than the one already in
flight.

<!-- Source: src/audit/verbose-diagnostic-path.ts -->
<!-- Source: src/audit/verbose-diagnostic-writer.ts -->
<!-- Source: src/controller/phase-runner.ts -->
<!-- Source: src/config/settings-schema.ts -->

The sidebar phase log is a *view* of `stream.jsonl`, not another on-disk copy.
The reader discovers iteration directories, parses and projects stream events,
caps entry count and per-field bytes, and then applies the host's shared secret
sanitizer before content crosses to the webview. Live tailing uses the same
sanitization boundary. The source diagnostic file is never modified.

<!-- Source: src/services/phase-log/phase-log-reader.ts -->
<!-- Source: src/services/phase-log/phase-log-sanitizer.ts -->
<!-- Source: src/services/phase-log/phase-log-truncator.ts -->
<!-- Source: src/services/phase-log/types.ts -->

## Runtime and transport logs

The runtime log mirrors sanitized host records. An empty
`schegent.logging.runtimeLogFilePath` selects `.schegent/syslog`; a relative
path is workspace-relative and may not contain `..`. In production an absolute
path must remain under the current workspace, the extension's global storage,
or the OS temporary directory. The operator's home directory is deliberately
not an allowed root.

<!-- Source: src/lib/runtime-log/runtime-log-path.ts -->
<!-- Source: src/activation/backend-wiring.ts -->

The runtime accessor re-reads level, path, and rotation settings on each emit.
The default level is `INFO`; the default rotation threshold is 5 MiB; and the
default is three generations. Allowed ranges are 64 KiB through 1 GiB and zero
through twenty generations. A failed path is suppressed until the settings
save callback clears suppression.

<!-- Source: src/lib/runtime-log/runtime-log-settings.ts -->
<!-- Source: src/lib/runtime-log/runtime-log-sink.ts -->
<!-- Source: src/config/settings-schema.ts -->

The CLI transport sink records one tab-separated line as
`timestamp`, `runId`, `phase`, `stdout|stderr`, and sanitized CLI content. It
retains paths because path-bearing CLI output is operationally useful, but it
uses the same secret sanitizer as the host logger. Capture is best-effort: an
I/O failure warns and the phase continues. Its bounds are code-resident at 5
MiB and three generations, or at most four files per workspace.

<!-- Source: src/monitor/cli-transport-sink.ts -->
<!-- Source: tests/unit/monitor/cli-transport-sink.test.ts -->

## Retention and deletion

Session retention groups `raw-<runId>.log` and the matching `<runId>/`
diagnostic tree as one artifact group. The defaults are 30 days and 512 MiB,
configurable from one day to 3650 days and from 1 MiB to 10 GiB. The sweep
removes expired inactive groups first, then the oldest inactive groups until
the byte budget is met. Running and paused Run IDs are protected. Sweeps run at
activation, after terminal transitions, and when either retention setting
changes.

<!-- Source: src/services/session-retention/session-artifact-retention-service.ts -->
<!-- Source: src/config/settings-schema.ts -->
<!-- Source: src/extension.ts -->
<!-- Source: src/activation/run-safety-wiring.ts -->

The sweep proves the sessions root and every candidate remain contained before
recursive removal. It cannot select `.schegent/audit.log` because that file is
outside its root. Each completed sweep reports only aggregate usage and
outcomes through `session-retention-applied`.

<!-- Source: src/services/session-retention/session-artifact-retention-service.ts -->
<!-- Source: tests/unit/services/session-retention/candidate-containment.test.ts -->

Task deletion can separately remove the matching raw transcript and per-run
session directory. It does not erase structured audit events. Treat every raw
or verbose file as sensitive local material even though Schegent makes a
best-effort attempt to create `.schegent/.gitignore`.

<!-- Source: src/services/session-cleanup/session-cleanup-service.ts -->
<!-- Source: src/audit/schegent-gitignore.ts -->

## Recovery checkpoints are outside the session tree

Immediately before a Git-capable Phase, Schegent may write a binary Git patch
and JSON metadata under the extension's `globalStorage/checkpoints/<runId>/`
tree. Run directories are mode `0700`; patch, metadata, and decline-marker
files are mode `0600`. These files can contain unredacted source, paths, and
other working-tree material. There is no in-product restore command: an
operator must inspect the recorded base commit and apply an appropriate patch
manually.

<!-- Source: src/services/run-checkpoint-service.ts -->

Per-run pruning keeps twenty checkpoint prefixes. Cross-run retention removes
directories older than 14 days, then applies a 256 MiB total bound while
protecting the ten newest directories from the size bound. The recent-run floor
does not override the age bound. The sweep is scheduled at activation and is
best-effort.

<!-- Source: src/services/run-checkpoint-service.ts -->
<!-- Source: src/services/run-checkpoint-retention.ts -->
<!-- Source: src/activation/run-safety-wiring.ts -->
<!-- Source: tests/unit/services/run-checkpoint-retention.test.ts -->

For the structured event schema and metadata-only export behavior, see
[Audit events](../reference/audit-events.md).
