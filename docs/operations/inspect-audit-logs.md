# Inspect structured audit logs

Schegent's structured audit is workspace-local JSON Lines at
`.schegent/audit.log`. Each line is host-projected lifecycle metadata, not a
verbatim backend transcript. Use it to reconstruct observed Task, Phase, Queue,
monitor, catalog, trust, reset, and retention transitions without treating it
as a record of every byte emitted by a CLI.
<!-- Source: src/audit/audit-log-writer.ts -->
<!-- Source: src/audit/audit-payload.ts -->
<!-- Source: src/contracts/audit-events.ts -->

## Open or export the active log

Run **Schegent: Show Audit Log** from the Command Palette
(`schegent.showAuditLog`). The command opens the active workspace's
`.schegent/audit.log` as a preview editor while preserving focus. If the file
does not exist or cannot be opened, Schegent reports “no audit log yet.” The
status-bar command and the sidebar's open-audit action route to the same
command.
<!-- Source: package.json -->
<!-- Source: src/commands/show-audit.ts -->
<!-- Source: src/ui/status-bar.ts -->
<!-- Source: src/ui/sidebar/commands/cmd-open-audit-log.ts -->

For a shareable reduced view, run **Schegent: Export Metadata-Only Audit**
(`schegent.exportAuditLog`). It reads only the active log, prompts for a save
location defaulting to `schegent-audit-v3.jsonl`, and writes only parsable
schema-v3 rows.
<!-- Source: package.json -->
<!-- Source: src/commands/export-audit.ts -->

The metadata-only export removes `runId`, `correlationId`, and all payload keys
except `exitCode`, `fileChangeCounts`, `metrics`,
`omittedFileEvidenceCount`, `omittedToolEvidenceCount`, `outcome`,
`terminationReason`, and `toolCategoryCounts`. It retains the audit event ID,
timestamp, event type, phase, iteration, outcome, and schema version. Rows from
other schema versions or with invalid envelopes are omitted.
<!-- Source: src/commands/export-audit.ts -->
<!-- Source: tests/unit/commands/export-audit.test.ts -->

Prefer that export when sending evidence outside the workspace. The active log
still contains run/correlation identifiers, operator-defined phase IDs, event
types, and bounded structured metadata even though unsafe payload detail is
excluded.
<!-- Source: src/audit/audit-entry.ts -->
<!-- Source: src/audit/audit-payload.ts -->
<!-- Source: src/commands/export-audit.ts -->

## Locate active and rotated evidence

The active path and archive shape are:

```text
.schegent/audit.log
.schegent/audit.log.YYYYMMDD-HHMMSS-mmm-xxxxxxxx
```

The eight-character suffix comes from a UUID. Retention also recognizes the
legacy seconds-only `audit.log.YYYYMMDD-HHMMSS` form. Files such as
`audit.log.backup` or `audit.log.bak` do not match the retention pattern and
are not deleted by the audit writer.
<!-- Source: src/audit/audit-log-writer.ts -->

Before each append, the writer rotates when the current file is at least the
configured size threshold or at least the configured maximum age. The exposed
settings are `schegent.audit.rotation.sizeMB` (default 5, minimum 1) and
`schegent.audit.rotation.maxAgeDays` (default 30, minimum 1).
<!-- Source: src/audit/audit-log-writer.ts -->
<!-- Source: package.json -->
<!-- Source: src/extension.ts -->

By default, at most ten recognized archives younger than 90 days are retained;
the active `audit.log` is never pruned. The retention sweep runs at writer
construction and after a successful rotation. It is best-effort, and refuses
rotation or deletion when filesystem containment cannot be established.
<!-- Source: src/audit/audit-log-writer.ts -->
<!-- Source: tests/unit/audit/retention.test.ts -->

Every runtime writer also attempts to create `.schegent/.gitignore` with `*` so
the directory's contents remain local. An existing operator-managed ignore file
is not overwritten. This is a best-effort source-control guard, not access
control or tamper protection.
<!-- Source: src/audit/schegent-gitignore.ts -->

## Read the JSONL envelope

Current writes use audit schema version `3`. A produced entry contains:

```json
{
  "id": "<uuid>",
  "timestamp": "<ISO-8601 timestamp>",
  "runId": "<run identifier>",
  "phase": "<non-empty phase identifier>",
  "iteration": 1,
  "eventType": "phase-end",
  "payload": {},
  "outcome": "success",
  "schemaVersion": 3,
  "correlationId": "<correlation identifier>"
}
```

`outcome` is `success`, `failure`, or `info`. Phase identifiers are
operator-defined and are not constrained to a built-in list. If a caller does
not supply `correlationId`, the writer uses `runId`.
<!-- Source: src/audit/audit-entry.ts -->
<!-- Source: src/contracts/audit-events.ts -->
<!-- Source: src/audit/audit-log-writer.ts -->
<!-- Source: src/parser/audit-log-parser.ts -->

The exhaustive current and retired event-type registry is
`src/contracts/audit-events.ts`. Retired read-only values remain in the
registry so historical archives stay parseable; an event's presence in that
union does not prove that current code still emits it.
<!-- Source: src/contracts/audit-events.ts -->
<!-- Source: tests/lint/no-transport-in-audit.test.ts -->

Payloads are projected by event type before append. Generic projection omits
command, argument, prompt, output, path, endpoint, conversation/session, file,
and workspace-root keys; bounds nesting, strings, arrays, and total payload
bytes; and rejects non-finite values or residual path/endpoint strings.
Specialized v3 projections reduce CLI invocations to execution metadata and
Phase file/tool evidence to counts.
<!-- Source: src/audit/audit-payload.ts -->
<!-- Source: tests/unit/audit/audit-payload-v3.test.ts -->

The full entry then passes through the shared sanitizer. If sanitization would
change the projected payload, the writer rejects the append as
`secret-detected` instead of persisting redacted payload evidence. Live
subscribers receive the same sanitized entry, including when the durable write
itself fails.
<!-- Source: src/audit/audit-log-writer.ts -->
<!-- Source: tests/unit/audit/sanitize-listener.test.ts -->
<!-- Source: tests/unit/audit/audit-log-writer.test.ts -->

## Query the active file

Validate that every non-empty line is JSON:

```bash
jq -c . .schegent/audit.log > /dev/null
```

Select one run or explicitly threaded correlation identifier:

```bash
jq -c --arg run '<run-id>' \
  'select(.runId == $run or .correlationId == $run)' \
  .schegent/audit.log
```

Show failures, Phase endings, or monitor events:

```bash
jq -c 'select(.outcome == "failure")' .schegent/audit.log
jq -c 'select(.eventType == "phase-end")' .schegent/audit.log
jq -c 'select(.eventType | startswith("monitor-"))' .schegent/audit.log
```

Count the event types present in the file:

```bash
jq -r '.eventType' .schegent/audit.log | sort | uniq -c | sort -nr
```

These filters follow the current envelope and hyphenated monitor event names.
Do not use historic `monitor.*` or `audit.hydration.warning` spellings as if
they were current event types.
<!-- Source: src/audit/audit-entry.ts -->
<!-- Source: src/contracts/audit-events.ts -->

The Show and Export commands inspect only the active file. When the relevant
run predates a rotation, apply the same `jq` filter to the recognized
`audit.log.<stamp>` archives as well. The history audit-pointer resolver scans
recognized archives followed by the active log, streams rather than loading
the whole corpus, and limits a resolved run to a bounded entry count.
<!-- Source: src/commands/show-audit.ts -->
<!-- Source: src/commands/export-audit.ts -->
<!-- Source: src/services/history/audit-pointer-resolver.ts -->

## Handle compatibility and malformed rows

`parseAuditLogLineDetailed` preserves a valid envelope when its `eventType` is
unknown and returns a warning. It also preserves a row whose persisted schema
version exceeds the runtime while warning about the version. This lets older
code retain forward evidence instead of silently deleting an unfamiliar event.
<!-- Source: src/parser/audit-log-parser.ts -->
<!-- Source: tests/unit/parser/audit-log-parser-monitor.test.ts -->

Malformed JSON, non-object values, and rows missing a required envelope field
produce no parsed entry. The sidebar cold-start reader drops such rows, emits at
most one sanitized warning per read, and does not modify the file. Metrics and
history readers count parse warnings while continuing over surrounding valid
rows.
<!-- Source: src/parser/audit-log-parser.ts -->
<!-- Source: src/ui/sidebar/audit-tail-coldstart.ts -->
<!-- Source: tests/unit/ui/sidebar/audit-tail-coldstart.test.ts -->
<!-- Source: src/metrics/metrics-service.ts -->
<!-- Source: src/services/history/audit-pointer-resolver.ts -->

When an unknown type appears, record the literal, schema version, extension
version, file name, and neighboring event IDs before changing anything. An
unknown type may be forward-compatible evidence or a historical read-only
event; it is not, by itself, permission to edit or delete the row.
<!-- Source: src/parser/audit-log-parser.ts -->
<!-- Source: src/contracts/audit-events.ts -->

## Diagnose missing durable evidence

Appends are serialized. Each filesystem append has a five-second timeout; a
failed append rejects to its caller, reports structured evidence as
unavailable through the evidence-health path, and does not poison later
appends. Rotation and retention failures are warning-only so the writer can
continue using the active file where safe.
<!-- Source: src/audit/audit-log-writer.ts -->

If expected rows are absent:

1. Check the active file and recognized archives before concluding the event
   was never written.
2. Inspect the sanitized Schegent runtime log for `audit append failed;
   structured evidence is unavailable`, append timeout, rotation, retention,
   gitignore, or containment-refusal warnings.
3. Check filesystem writability and available space without moving or deleting
   the evidence corpus.
4. Use the run ID and event metadata from runtime/UI evidence to bound the gap.
5. Preserve the files before attempting recovery.

The writer's failure warning includes event ID, event type, run ID, and an
available errno, but deliberately excludes payload and path bytes.
<!-- Source: src/audit/audit-log-writer.ts -->

Audit files are plain local JSONL with rotation and retention; the writer does
not add a signature, hash chain, or immutable-storage guarantee. Treat them as
useful host-observed evidence, not proof that a local operator or process could
not alter the files after writing.
<!-- Source: src/audit/audit-log-writer.ts -->
