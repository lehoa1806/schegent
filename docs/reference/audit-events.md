# Audit events

Schegent writes structured audit evidence as newline-delimited JSON. The active
file is `<workspace>/.schegent/audit.log`; each line is one event. This is a
local operational record, not a remote telemetry stream, and it is distinct
from raw CLI transcripts and the human-oriented runtime log.

<!-- Source: src/audit/audit-log-writer.ts -->
<!-- Source: src/audit/schegent-gitignore.ts -->

## Event envelope

Every accepted event has this top-level shape:

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | UUID assigned by the writer. |
| `timestamp` | string | ISO-8601 timestamp assigned by the writer. |
| `runId` | string | Run attribution supplied by the emitter. System-scoped events still use the common envelope. |
| `phase` | string | Phase identifier; operator-defined, non-empty identifiers are preserved by the reader. |
| `iteration` | number | Phase or run iteration supplied by the emitter. |
| `eventType` | `AuditEventType` | Literal from the canonical event registry. |
| `payload` | object | Event-specific, projected metadata. |
| `outcome` | `success \| failure \| info` | Result classification. |
| `schemaVersion` | number, optional on historical input | Current writes use version `3`. |
| `correlationId` | string, optional | Defaults to `runId` when the writer is not given one. |

<!-- Source: src/audit/audit-entry.ts -->
<!-- Source: src/audit/audit-log-writer.ts -->
<!-- Source: src/contracts/audit-events.ts -->

The parser rejects malformed JSON and records missing required fields as a
warning. It preserves a structurally valid event whose type is unknown, with a
warning, so logs written by newer or older releases remain inspectable. It also
preserves records with a schema version newer than the running extension and
reports the version mismatch.

<!-- Source: src/parser/audit-log-parser.ts -->

## Event registry and scope

`ALL_AUDIT_EVENT_TYPES` is the exhaustive code-level registry. It groups event
literals into these families:

| Family | Representative events | What it records |
| --- | --- | --- |
| Phase and runner | `phase-start`, `phase-end`, `cli-invocation`, `file-write` | Phase execution and backend invocation metadata. |
| Lifecycle and monitor | `pause`, `resume`, `warning`, `error`, `monitor-invocation-summary` | Run state and bounded transport summaries. Historical per-line monitor literals remain readable even though their writers are retired. |
| Audit and retention | `audit-rotated`, `audit-retention-applied`, `audit-schema-warning`, `session-retention-applied` | Evidence-pipeline maintenance and retention outcomes. |
| Retry and phase control | `phase.retry_evaluated`, `retry-scheduled`, `phase-paused`, `phase-restarted`, `phase-skipped` | Automated retry decisions and operator phase actions. |
| Queue, task, and scheduling | `queue-created`, `task-enqueued`, `task-reordered`, `schedule-set`, `scheduled-start-fired` | Queue mutations, task lifecycle, and delayed-start transitions. |
| Phase messages, logs, and breakpoints | `phase-message-emitted`, `phase-log-read`, `phase-breakpoint-fired` | Cross-phase messages and phase-level operator tooling. |
| State and workspace | `state-migrated`, `workspace-state-reset`, `multi-root.warning-shown`, `trust.capability-denied` | Migrations, reset transactions, workspace topology, and trust refusals. |
| Execution and diagnostics | `task-execution-started`, `task-execution-ended`, `backend-ping`, `metrics-view-opened` | Task-level timing and explicit diagnostics/UI adoption. |
| Catalog and exchange | `process-exchange-export`, `process-exchange-import-committed`, `definition-published`, `definition-restored` | Phase/package exchange and versioned catalog lifecycle operations. |
| Concurrency | `runs-overlapped` | A workspace-level overlap episode when in-flight execution crosses from one run to two. |

<!-- Source: src/contracts/audit-events.ts -->

Events are classified for the UI as `task` or `system`. The explicit
`SYSTEM_SCOPED_EVENT_TYPES` set contains workspace, queue, scheduling,
migration, catalog, diagnostics, and other run-independent events; all other
known events are task-scoped. Unknown event types default to task scope. The
exhaustive classifier test pins every current literal to one scope.

<!-- Source: src/contracts/audit-events.ts -->
<!-- Source: tests/unit/audit-events/event-classification.test.ts -->

## Payload projection and privacy boundary

The writer does not persist arbitrary emitter objects verbatim. It first runs
the event payload through `projectAuditPayload`, then applies the shared record
sanitizer. Event-specific projectors reduce sensitive evidence to bounded
metadata: for example, `phase-end` turns file lists into created/modified/deleted
counts, and `cli-invocation` keeps runner, operation, permission mode, model and
effort identifiers, continuation flags, and a diagnostics flag rather than the
spawned command.

<!-- Source: src/audit/audit-payload.ts -->
<!-- Source: tests/unit/audit/audit-payload-v3.test.ts -->

Generic projected values have a maximum nesting depth of four, strings are
bounded to 640 characters, and arrays are bounded to 100 elements. Keys that
could carry commands, prompts, output, paths, endpoints, session identifiers,
or similar content are omitted. Residual path- or endpoint-shaped strings,
invalid keys, unsupported values, and non-finite numbers are refused. The
whole projected payload is rejected if the later record sanitizer changes it,
which indicates secret-like content reached the boundary.

<!-- Source: src/audit/audit-payload.ts -->
<!-- Source: src/audit/audit-log-writer.ts -->

These controls reduce accidental disclosure. Tamper-evidence is provided
separately, by the hash chain FR-R3-112 added: each entry carries the previous
entry's sha256 digest, and `npm run audit:verify` names the first break. Anyone
or any process with sufficient filesystem access can still alter or delete local
evidence — the chain makes that **evident, not impossible**, because the chain
head sits on the same disk and an actor who can edit the log can recompute every
later digest. What they cannot do is edit one entry and leave the rest
consistent. There is no signature, and no anchor outside the workspace.
<!-- Source: src/audit/audit-chain.ts -->

<!-- Source: src/audit/audit-log-writer.ts -->

## Storage, rotation, and retention

The writer serializes appends, creates `.schegent/` on demand, and makes a
best-effort attempt to create `.schegent/.gitignore` without overwriting an
operator-managed file. An append that takes longer than five seconds fails and
is reported to the sanitized runtime logger; later appends can still proceed.

<!-- Source: src/audit/audit-log-writer.ts -->
<!-- Source: src/audit/schegent-gitignore.ts -->

The default active-log rotation thresholds are 5 MiB or 30 days. They are
configured by `schegent.audit.rotation.sizeMB` and
`schegent.audit.rotation.maxAgeDays`, both resource-scoped numbers with a
minimum of `1`. Rotated files use the `audit.log.<timestamp>-<suffix>` naming
form. Rotation checks both paths against the workspace containment boundary
before renaming.

<!-- Source: src/config/settings-schema.ts -->
<!-- Source: src/extension.ts -->
<!-- Source: src/audit/audit-log-writer.ts -->

The writer keeps at most ten recognized archives by default and gives archives
a default maximum age of 90 days, with a hard seven-day minimum. Retention runs
at writer construction and after rotation. It never prunes the active
`audit.log`, ignores unrelated siblings such as `audit.log.backup`, and treats
pruning failures as best-effort runtime-log warnings.

<!-- Source: src/audit/audit-log-writer.ts -->
<!-- Source: tests/unit/audit/retention.test.ts -->

## Reading and exporting

Run `Schegent: Show Audit Log` (`schegent.showAuditLog`) to open the active
workspace audit file. If no log exists, the extension reports that condition
instead of creating an empty file.

<!-- Source: src/commands/show-audit.ts -->
<!-- Source: package.json -->

Run `Schegent: Export Metadata-Only Audit` (`schegent.exportAuditLog`) to choose
a JSONL destination. Export includes only valid schema-v3 records and keeps the
envelope's identity, timestamp, event type, phase, iteration, outcome, and
schema version. Payload export is restricted to counts and structural result
fields such as `metrics`, `fileChangeCounts`, `toolCategoryCounts`, `exitCode`,
`terminationReason`, and omitted-evidence counts. It deliberately omits
`runId`, `correlationId`, and all other payload fields.

<!-- Source: src/commands/export-audit.ts -->
<!-- Source: tests/unit/commands/export-audit.test.ts -->

The export is a privacy-reduced operational artifact, not a byte-for-byte
backup. Preserve the original local JSONL and any rotated archives when a
forensic investigation requires the complete structured record.

<!-- Source: src/commands/export-audit.ts -->
