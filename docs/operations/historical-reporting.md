# Historical Reports and Exports (`FR-R6-F11`)

**Declared**: 2026-11-10 (`specs/310-historical-reporting-exports/spec.md`)

This guide is for an operator who reads historical execution reports, exports them to a file, or
saves them to compare later. A report reads the run store and, for usage, the accounting service.
It never starts, resumes or changes an execution. The only rows it writes are the reporting
tables' own: saved reports and export records.

Implemented in:
- [`src/contracts/reporting/report-query.ts`](../../src/contracts/reporting/report-query.ts)
- [`src/contracts/reporting/report-outcomes.ts`](../../src/contracts/reporting/report-outcomes.ts)
- [`src/contracts/reporting/report-manifest.ts`](../../src/contracts/reporting/report-manifest.ts)
- [`src/services/reporting/index.ts`](../../src/services/reporting/index.ts)
- [`src/services/reporting/report-engine.ts`](../../src/services/reporting/report-engine.ts)
- [`src/services/reporting/report-snapshots.ts`](../../src/services/reporting/report-snapshots.ts)
- [`src/services/reporting/snapshot-capture.ts`](../../src/services/reporting/snapshot-capture.ts)
- [`src/services/reporting/csv-profile.ts`](../../src/services/reporting/csv-profile.ts)
- [`src/services/reporting/export-service.ts`](../../src/services/reporting/export-service.ts)
- [`src/services/reporting/export-reconciler.ts`](../../src/services/reporting/export-reconciler.ts)
- [`src/services/reporting/saved-reports.ts`](../../src/services/reporting/saved-reports.ts)
- [`src/headless/reporting-api.ts`](../../src/headless/reporting-api.ts)

For the accounting figures the usage view reads, see
[Usage and metrics accounting](usage-accounting.md).

## Production status

The reporting service, its schema and the headless port ship in this release. Production does
not construct a reporting service yet: it needs the application store opened in the extension
host (the F01-B cutover), as the accounting service does. There is no report UI in this release;
it is deferred to `FR-R6-F12`, which owns the execution visibility surfaces. The headless port is
the single entry the UI will call, so the two cannot disagree.

## Views

Every report covers one absolute range: 30 days by default, 90 days at most. The run views read
it as root creation times; the `usage` view reads it as accounting event times, and its manifest
names that basis (`accounting-event`). Roots and attempts are counted separately, and each
duration states its basis.

| View | What a row is | Notes |
|---|---|---|
| `execution-summary` | One root, or one group of roots | Groups by workflow, frozen definition or outcome; up to 3 group dimensions. |
| `attempt-detail` | One attempt | No grouping. |
| `failure-cause` | One failure cause | Causes are classified; a cause that names a path is reported as `other`, never with the path. |
| `workflow-revision` | One workflow and frozen definition | Duration distributions include an `unavailable` count for open or unrecorded durations. |
| `time-series` | One local day | Days are cut in the query's time zone; the manifest names it. |
| `usage` | One backend and model | Read from the accounting service, unchanged. Filters on root, backend and model only; others are refused `unsupported-dimension`. |

A report is captured once, under a bounded snapshot, and frozen for its lease. Pages, drill-down,
export and save all read that one snapshot, so a page read later cannot see a newer run. Drill-down
returns the root, its attempts, the frozen definition identity, outcome lineage and the root's
usage. It returns no evidence references: the artifact catalogue is not keyed by root. Drill-down
reads usage at the report's accounting revision, but the accounting service keeps an attempt's
outcome, backend and model as current values, not per revision; an outcome recorded after the
report was captured can therefore appear in its lineage and usage grouping.

Invocations are reported as not recorded. Neither execution records nor accounting rows carry an
invocation count a report may read.

The usage view's unattributed count, gap counts and legacy summary cover the whole accounting
store: the accounting service reports them as current, store-wide counts, so the report's range,
filters and roots do not narrow them. The accounting store a reporting service is given must
belong to its workspace. The accounting query does not filter by workspace, so a store shared
between workspaces would report other workspaces' usage. The change that opens the accounting
store in the host must keep one store per workspace, or scope the query by workspace.

## Bounds

Every bound ends in a typed outcome. A capped report is never returned as a shorter success.

| Bound | Value | Outcome when reached |
|---|---|---|
| Queries executing per workspace | 2 | A third waits. |
| Queries waiting | 8 | `refused` `query-busy` |
| Queued parameter bytes | 1 MiB | `refused` `query-limited` |
| Rows one snapshot may hold | 100,000 roots or attempts | `limited` `snapshot-rows` |
| Working data, shared by live reports | 32 MiB | `limited` `working-data` |
| Query deadline | 5 s | `limited` `deadline-exceeded` |
| Live reports | 4 | `refused` `report-lease-limit` |
| Report lease | 5 minutes | `expired`, with the instruction `restart-report-query` |
| Page size | 50 by default, 200 at most | `refused` `invalid-query` |
| Page bytes | 1 MiB; a page always holds at least one row | The page ends early and gives a cursor. |
| Range | 90 days | `refused` `invalid-query` |

Working data is estimated as two bytes per UTF-16 code unit of every string value, plus 64 bytes
per row. A run view holds its captured roots and attempts plus its built rows; a `usage` view holds
its rows once, since they are the captured population. On the 100,000-attempt fixture, `attempt-detail` over 30 days needs more than 32 MiB and
ends `limited` with `working-data`. Narrow the range or filter by workflow.

The work yields to the host every 8 ms. A cancelled query answers `cancelled` and releases its
slot and its working data. Measured values are recorded in the feature's `research.md` (R1).

## Exports

An export writes a live report to a file the operator names, as JSON or CSV, with a manifest
beside it named `<file>.manifest.json`. Exports contain metadata only: no prompt, output, log or
artifact content.

**Destination.** The destination must be a local file outside the workspace's `.schegent/` store.
The workspace root is fixed when the reporting service is constructed; a request cannot name it.
It is checked before anything is created: a remote scheme is refused `destination-not-local-file`,
a path into the store (through a link, a `..` or a case variant too) is refused
`destination-in-evidence-store`, and a path that cannot be resolved is refused
`destination-unresolvable`. No directory is ever created. Without overwrite, an existing data or
manifest file is refused `destination-exists`. The final path is checked again, against the
directory as resolved, just before the partials are opened, so a directory swapped for a link into
the store after the first check is refused `destination-in-evidence-store`. A swap in the short
window between that second check and the publish is not detected; the destination's parent
directory is the operator's to protect.

**Caps.** 100,000 data rows, 64 MiB of output and 60 seconds, ending `limited` with `export-rows`,
`export-bytes` or `export-time`. Writes go through an 8 MiB buffer. One export runs per workspace
at a time; a second is refused `export-busy`.

**Publication.** Both files are written as hidden partials named `.<file>.<exportId>.data.partial`
and `.<file>.<exportId>.manifest.partial`, hashed as they are written and synced. The data file is
published first, then the manifest. A file at the final name is therefore always complete. If the
manifest cannot be published, the data file stays and the export ends `failed`
`manifest-publish-failed`: a data file with no manifest beside it is incomplete. With overwrite,
an earlier export's manifest may still sit beside the new data file in that case; its SHA-256 and
length then do not match the data, so check them, and treat the pair as incomplete. Every outcome
removes only that export's own partials.

Without overwrite, each file is published with a hard link, so a file that appears at the final name
while the export runs is never replaced (for the data file, `destination-exists`). A volume that
does not support hard links (FAT or exFAT media, some network and FUSE mounts) therefore fails every
export without overwrite (`publish-failed`); export with overwrite there, or to a local volume.

**Reconciliation.** A host that stops mid-export leaves a `pending` export record. The next export,
or the host's start-up call to `reconcileExports`, ends every pending record older than 2 minutes
as `failed` `host-stopped` and removes its partials: only names equal to that export's own two
partial names, and only when each is proven a direct entry of the staging directory. A record
younger than 2 minutes is left alone, so for up to 2 minutes after a crash a new export can still
be refused `export-busy`; after that, the crash never holds the workspace busy.

**Store failures.** If the export records cannot be read or written (the database is locked,
damaged or full), the export, or `reconcileExports`, ends `failed` `write-failed`. The log line
carries the operation and that reason only. If the records fail after both files are published,
the pair on disk is complete, but the export still answers `write-failed`. Its record stays
`pending` until reconciliation ends it.

**JSON is the exact format.** The data file is one object,
`{schema: "schegent.report-data", schemaVersion, reportId, view, calculationVersion, columns, rows}`,
with one object per row and every value as stored.

**CSV is for viewing.** CSV profile version 1:

- Every field is quoted, an embedded `"` is doubled, records end with CRLF, and the file is UTF-8
  with no byte-order mark.
- A text cell is `text:` plus the value, so no cell starts a spreadsheet formula.
- Invisible, control and bidirectional characters, every Unicode default-ignorable code point
  (variation selectors, tag characters, Hangul fillers), and lone surrogates are written as
  `\u{XXXX}` escapes; a backslash is written as `\\`. So an emoji's presentation selector or
  joiner appears as an escape in CSV; the JSON export keeps the text exact.
- Text longer than 4,096 code points is cut and ends `\u{2026}[truncated]`.
- An integer beyond ±(2^53 − 1), or a decimal with more than 15 significant digits, is `number:`
  plus its exact digits.
- An unknown value is the empty field `""`, never zero.

The CSV manifest counts each transformation (`text-prefix`, `control-escaped`, `truncated`,
`number-prefixed`) and carries the statement that JSON is the exact format.

**Manifest.** Every manifest names the report and export identities, the canonical query and its
digest, the source cutoff, the time zone and time basis, the source, schema and calculation
versions, the accounting revision, coverage (roots, attempts, unknown durations, unattributed
usage and gaps), omissions, units, the population digest, and the data file's name, length and
SHA-256. It states the privacy profile `metadata-only` and the retention statement
`outside-managed-retention`: an exported file is outside managed retention, and no retention
sweep removes it.

## Saved reports

`saveReport` stores a live report's canonical query and an immutable manifest. Saving the same
report again answers the stored record.

- `rerunSavedReport` runs the saved absolute range at a new cutoff, under a new report identity
  linked to the saved one. It stores nothing until it is saved.
- `reproduceSavedReport` re-reads the population at the saved cutoff and accounting revision. It
  answers `reproduced` only when the recomputed population digest equals the saved one. Otherwise
  it answers `source-no-longer-reproducible` with the reason `calculation-version-changed`,
  `population-changed` or `accounting-revision-unavailable` (the revision was compacted away).
- `deleteSavedReport` removes the record only. It never touches an exported file. A re-run's link
  to a deleted parent becomes empty; the re-run's own manifest keeps the identity it was saved with.

## Trust

The headless port checks each request's exact key set and types first and refuses
`invalid-query` otherwise. It then reads workspace trust at each call: in an untrusted workspace,
export, save, delete and export reconciliation (which removes files) are refused
`workspace-untrusted`. Reads, re-runs and reproduction still answer, because they write nothing.

## Not in this release

- The report UI, its accessibility and keeping the last complete report on screen
  (`FR-R6-F12`).
- Backend and model filters on the run-derived views: execution and attempt records carry no
  backend or model.
- Evidence references in drill-down.
- ACP attribution joins (`FR-R6-F13`) and phase-handoff and review metadata joins (`FR-R6-F15`).
