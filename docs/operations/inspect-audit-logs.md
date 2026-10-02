# Inspect structured audit logs

Schegent's structured audit is workspace-local JSON Lines at
`.schegent/audit.log`. Each line is host-projected lifecycle metadata, not a
verbatim backend transcript. Use it to reconstruct observed Task, Phase, Queue,
monitor, catalog, trust, reset, and retention transitions without treating it
as a record of every byte emitted by a CLI.
<!-- Source: src/audit/audit-log-writer.ts -->
<!-- Source: src/audit/audit-payload.ts -->
<!-- Source: src/contracts/audit-events.ts -->

On POSIX the log, its archives and `audit.log.cuts` are `0600` inside a `0700`
`.schegent/`. A file left wider by an earlier release is narrowed in place: the
live log on the next append, archives by the retention sweep at host start. Its
lines and hash chain are unchanged, so `npm run audit:verify` reads it as
before. [Who can read them](../concepts/sessions-and-logs.md#who-can-read-them)
covers every evidence sink.
<!-- Source: src/audit/audit-log-writer.ts -->
<!-- Source: src/lib/safe-open.ts -->

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
except `attemptId`, `cause`, `exitCode`, `fileChangeCounts`, `metrics`,
`omittedFileEvidenceCount`, `omittedToolEvidenceCount`, `outcome`,
`resultEnvelope`, `stalled`, `terminationReason`, and `toolCategoryCounts`. Four
of those are also
value-checked on the way out, because the export reads whatever bytes are on disk
rather than what the current writer produces. The check is scoped by event type:
on `phase-end` only the literals `cap_exhausted` and `pre_spawn_refusal` survive
as a `cause`, while the other families
that carry a `cause` — `phase-breakpoint-cleared`, `task-reordered`,
`monitor-rate-limited`, the backend-ping failures, the delayed-retry pauses — keep
their own vocabularies, admitted by shape as a short lowercase token. `stalled`
must be a positive whole number, `attemptId` must be the UUID shape the writer
mints, and `resultEnvelope` must be `received` or `absent`. A rejected value
exports as `null` rather than
being dropped, so a field that was on disk never reads as one that was never
recorded. It retains the audit event ID,
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

On a `phase-end` row, **an absent count is not a zero.** Three fields behave this
way, and all three are omitted together:

- `fileChangeCounts` — the `{created, modified, deleted}` triple;
- `omittedFileEvidenceCount` — file paths the projection dropped;
- `omittedToolEvidenceCount` — commands the projection dropped.

They are written only when the phase's audit block was actually parsed. So
`"fileChangeCounts": {"created": 0, "modified": 0, "deleted": 0}` is a
measurement — the block was read and listed nothing — while the fields being
missing means the phase ended before anything could be read, which is what a
phase killed at its absolute deadline or idle timeout, refused before spawn, or
cancelled mid-flight looks like. Read the missing case as *unknown*, never as
*nothing happened*: a phase can create files and then be killed.

**One exception, and it is historical.** The `deleted` member of that triple was
not forwarded by the writer until 2026-09-13. The phase runner handed the
projection the created, modified and command lists and dropped the deleted one,
so the projection counted an absent value as `0`. In a row written before that
date, a `deleted: 0` is therefore **not** a measurement — it is the same
absent-versus-zero confusion described above, occurring inside a row that is
otherwise honest. Nothing in the row distinguishes the two cases: the schema
version did not change, so the row's timestamp is the only discriminator. The
`created` and `modified` members were always real. `omittedFileEvidenceCount`
sums all three, so in those same rows it under-reports by however many paths the
phase deleted; `omittedToolEvidenceCount` is unaffected, because the command
list was always forwarded.

`omittedToolEvidenceCount` is the one to be most careful with, because its zero
reads as a positive claim about what the phase **ran**. A `0` there says the
projection dropped no commands; an absent field says nobody counted, and the
phase may have executed anything at all. When you need to know whether a
terminated phase touched the tree, `terminationReason` tells you why the row
exists and these three fields tell you whether the question was ever asked.
<!-- Source: src/audit/audit-payload.ts -->
<!-- Source: src/controller/phase-runner.ts -->
<!-- Source: tests/unit/audit/audit-payload-v3.test.ts -->
<!-- Source: tests/unit/controller/phase-runner-outcome.test.ts -->

## Pair a phase start with its end

Every `phase-start` row is an attempt, and every `phase-end` row carries
`payload.attemptId` — the `phase-start` row's own `id`. Pair on that field, never
on position in the file and never on `(runId, phase, iteration)`: a retried phase
produces several attempts under one such triple, and interleaved runs put other
rows between a start and its end.

```bash
# Attempts that were opened and never closed.
jq -r 'select(.eventType == "phase-start") | .id' .schegent/audit.log | sort > /tmp/started
jq -r 'select(.eventType == "phase-end") | .payload.attemptId // empty' \
  .schegent/audit.log | sort > /tmp/ended
comm -23 /tmp/started /tmp/ended
```

Output here means a phase began and the host never recorded how it ended. An
attempt closed twice — the same `attemptId` on two `phase-end` rows — is the
other failure worth checking for, and means the same thing in reverse: the two
rows disagree and neither is the verdict.

```bash
jq -r 'select(.eventType == "phase-end") | .payload.attemptId // empty' \
  .schegent/audit.log | sort | uniq -d
```

Rows written before feature 212 shipped carry no `attemptId` at all. They are
excluded above rather than reported as unpaired, which is why `// empty` is
there: an archive that predates the field would otherwise read as one long
outage.

Age is not the only reason a `phase-end` row carries no `attemptId`, so do not
read a bare one on a current build as a half-finished rollout. The controller
appends its own cap-exhaustion row through
`PhaseRunner.appendCapExhaustedPhaseEnd()`, called from `src/services/run-driver.ts`,
after the runner has already closed the attempt with a terminal row of its own.
That row states a run-level verdict rather than the end of an attempt, so it
carries no `attemptId` by design and pairs with nothing. It is the only row in
the file with `terminationReason` `cap-exhausted`, which is how to separate the
expected ones from the rest:

```bash
# `phase-end` rows with no attemptId, grouped by why they exist.
jq -r 'select(.eventType == "phase-end" and (.payload.attemptId | not))
  | .payload.terminationReason // "(none)"' .schegent/audit.log | sort | uniq -c
```

`cap-exhausted` counts are expected at any age. Anything else here is either a
pre-212 archive or the gap worth chasing.
<!-- Source: src/controller/phase-attempt-recorder.ts -->
<!-- Source: src/controller/phase-runner.ts -->
<!-- Source: src/services/run-driver.ts -->
<!-- Source: src/audit/audit-payload.ts -->

## Count terminations that produced no verdict

`payload.resultEnvelope` on a `phase-end` row says whether the backend produced
its end-of-invocation result envelope. It has three readings, and the third is
the one to get right:

- `"received"` — the invocation ran and a verdict arrived.
- `"absent"` — the invocation **ran** and no verdict arrived. This is the
  population to count.
- **the field is missing** — UNKNOWN. Either the backend does not report the
  fact, or no process ever started (a phase refused before spawn, which carries
  `"cause": "pre_spawn_refusal"`). Never read a missing field as `"absent"`:
  doing so counts refusals as backends that ran and went silent, which is the
  opposite diagnosis.

```bash
# Ran, produced no verdict.
jq -c 'select(.eventType == "phase-end" and .payload.resultEnvelope == "absent")' \
  .schegent/audit.log

# The three readings, as a census.
jq -r 'select(.eventType == "phase-end")
       | .payload.resultEnvelope // "unknown"' .schegent/audit.log |
  sort | uniq -c | sort -nr
```

<!-- Source: src/controller/phase-runner.ts -->
<!-- Source: src/audit/audit-payload.ts -->
<!-- Source: tests/unit/controller/phase-runner-backend-posture.test.ts -->

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
