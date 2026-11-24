# Historical Reports and Exports (`FR-R6-F11`)

**Declared**: 2026-11-10 (`specs/310-historical-reporting-exports/spec.md`) · **Reconciled**: 2026-11-23 (`FR-R7-17`, `R7-17-01` / `R7-17-02`)

This guide is for an operator who reads historical execution reports, exports them to a file, or
saves them to compare later. A report reads the workspace's per-folder SQLite application store
and, for usage, the usage accounting service. It never starts, resumes, or changes an execution.
The only rows it writes are the reporting tables' own: saved reports and export records.

Implemented in:
- Contracts & validators:
  - [`src/contracts/reporting/report-query.ts`](../../src/contracts/reporting/report-query.ts)
  - [`src/contracts/reporting/report-outcomes.ts`](../../src/contracts/reporting/report-outcomes.ts)
  - [`src/contracts/reporting/report-manifest.ts`](../../src/contracts/reporting/report-manifest.ts)
  - [`src/contracts/reporting/report-rows.ts`](../../src/contracts/reporting/report-rows.ts)
  - [`src/contracts/validators/reporting-ipc.ts`](../../src/contracts/validators/reporting-ipc.ts)
- Reporting service:
  - [`src/services/reporting/index.ts`](../../src/services/reporting/index.ts)
  - [`src/services/reporting/report-engine.ts`](../../src/services/reporting/report-engine.ts)
  - [`src/services/reporting/report-snapshots.ts`](../../src/services/reporting/report-snapshots.ts)
  - [`src/services/reporting/snapshot-capture.ts`](../../src/services/reporting/snapshot-capture.ts)
  - [`src/services/reporting/report-drill-down.ts`](../../src/services/reporting/report-drill-down.ts)
  - [`src/services/reporting/csv-profile.ts`](../../src/services/reporting/csv-profile.ts)
  - [`src/services/reporting/export-service.ts`](../../src/services/reporting/export-service.ts)
  - [`src/services/reporting/export-reconciler.ts`](../../src/services/reporting/export-reconciler.ts)
  - [`src/services/reporting/saved-reports.ts`](../../src/services/reporting/saved-reports.ts)
- Headless port, extension host wiring & sidebar IPC:
  - [`src/headless/reporting-api.ts`](../../src/headless/reporting-api.ts)
  - [`src/activation/sqlite-cutover-wiring.ts`](../../src/activation/sqlite-cutover-wiring.ts)
  - [`src/activation/round6-visibility-wiring.ts`](../../src/activation/round6-visibility-wiring.ts)
  - [`src/ui/sidebar/commands/cmd-read-report.ts`](../../src/ui/sidebar/commands/cmd-read-report.ts)
  - [`src/ui/sidebar/commands/cmd-mutate-report.ts`](../../src/ui/sidebar/commands/cmd-mutate-report.ts)
- Sidebar webview UI:
  - [`webview-ui/src/lib/reporting-ipc.ts`](../../webview-ui/src/lib/reporting-ipc.ts)
  - [`webview-ui/src/components/MetricsDashboard/HistoricalReportsPanel.svelte`](../../webview-ui/src/components/MetricsDashboard/HistoricalReportsPanel.svelte)
  - [`webview-ui/src/components/MetricsDashboard/ReportRowsTable.svelte`](../../webview-ui/src/components/MetricsDashboard/ReportRowsTable.svelte)
  - [`webview-ui/src/components/MetricsDashboard/ReportDrillDownPanel.svelte`](../../webview-ui/src/components/MetricsDashboard/ReportDrillDownPanel.svelte)
  - [`webview-ui/src/components/MetricsDashboard/SavedReportsSection.svelte`](../../webview-ui/src/components/MetricsDashboard/SavedReportsSection.svelte)

Related guides:
- [Usage and metrics accounting](usage-accounting.md) — accounting figures read by the `usage` view and root drill-down.
- [SQLite application store](sqlite-application-store.md) — per-folder database layout (`<globalStorage>/sqlite/<scope>/schegent-state.db`, schema v9).
- [What Schegent keeps on this machine](evidence-retention-disclosure.md) — retention boundaries, external-file ownership, and in-flight export pinning.
- [Historical reporting 100,000-attempt performance measurement](historical-reporting-measurement.md) — benchmark results and verdicts against `NFR-002`, `NFR-004`, and `NFR-005`.

## Production status

Historical reporting is wired end to end in production:

1. **Per-folder SQLite store & service**: `sqlite-cutover-wiring.ts` opens each workspace folder's isolated SQLite database (`<globalStorage>/sqlite/<scope>/schegent-state.db`, schema version 9), constructs `ReportingService` bound to that folder's `workspaceId`, `workspaceRoot`, bounded read pool, and per-folder `UsageAccountingService`, and feeds `ReportingService.activeExportRootIds()` into `querySqliteProtectedRunIds` so active exports pin their referenced roots against session retention sweeps.
2. **Single headless port & sidebar IPC**: `round6-visibility-wiring.ts` wraps `ReportingService` with `createReportingApi(...)` and provides `exportReportWithDialog` using VS Code's native save dialog (`vscode.window.showSaveDialog`) so zero filesystem paths cross the webview IPC boundary. `MessageRouter` routes read operations through read-only `CMD_READ_REPORT` (`cmd-read-report.ts`, with per-router `WeakMap` active-query abort isolation) and mutating operations (`save`, `export`, `deleteSaved`) through gated concurrent `CMD_MUTATE_REPORT` (`cmd-mutate-report.ts`).
3. **Sidebar Historical Reports UI**: The Metrics dashboard's Reports view renders `HistoricalReportsPanel.svelte` (with `ReportRowsTable.svelte`, `ReportDrillDownPanel.svelte`, and `SavedReportsSection.svelte`), calling the same `ReportingApi` contract via `reporting-ipc.ts`.

## Views, filters, and UI scope

Every report covers one absolute range: 30 days by default, 90 days at most. The five run-derived views read it as root creation times (`root-created`); the `usage` view reads it as accounting event times (`accounting-event`), and its manifest names that basis. Roots, attempts, and invocations are kept distinct, and each duration distribution states its basis (`root-wall-clock` or `attempt-own`).

| View | Row shape | Supported filters (headless / IPC) | Grouping (`groupBy`) | Refused (`unsupported-dimension`) |
|---|---|---|---|---|
| `execution-summary` | `root` (ungrouped) or `group` | `rootId`, `workflowId`, `frozenDefinitionId`, `outcome` | Optional up to 3: `workflowId`, `frozenDefinitionId`, `outcome` | `backend`, `model`, or any other dimension |
| `attempt-detail` | `attempt` | `rootId`, `workflowId`, `frozenDefinitionId`, `outcome` | None | `backend`, `model`, any `groupBy` |
| `failure-cause` | `group` (fixed `failureCause`) | `rootId`, `workflowId`, `frozenDefinitionId`, `outcome` | Optional up to 2: `workflowId`, `frozenDefinitionId` | `backend`, `model`, `outcome`, `localDay`, `utcDay` |
| `workflow-revision` | `group` (fixed `workflowId`, `frozenDefinitionId`) | `rootId`, `workflowId`, `frozenDefinitionId`, `outcome` | Fixed only (no optional `groupBy`) | `backend`, `model`, any `groupBy` |
| `time-series` | `group` (fixed `localDay` in query timezone) | `rootId`, `workflowId`, `frozenDefinitionId`, `outcome` | Optional up to 2: `workflowId`, `outcome` | `backend`, `model`, `frozenDefinitionId`, `failureCause`, `utcDay`, `localDay` |
| `usage` | `usage` (default `backend`, `model`) | `rootId`, `backend`, `model` | Optional up to 3: `backend`, `model`, `utcDay` | `workflowId`, `frozenDefinitionId`, `outcome`, `failureCause`, `localDay` |

**Sidebar UI filter subset vs full headless/IPC contract.** Both `ReportingApi` and `CMD_READ_REPORT` enforce the complete 6-view filter, `groupBy`, `sort`, arbitrary `startMs`/`endMs` range (up to 90 days), IANA `timezone`, and `pageSize` (`1..200`) contract above. The sidebar toolbar in `HistoricalReportsPanel.svelte` intentionally presents a focused subset of controls:
- View selector (all 6 views), preset window (`7` / `30` / `90` days), and view-valid `sort` selector;
- `Workflow ID` and `Outcome` filters on the five run-derived views, and `Backend` filter on `usage`;
- Paging (`Load next page`), root drill-down, active-query `Cancel`, `Save report`, `Export CSV…` / `Export JSON…`, and saved-report `Run now`, `Check it still matches` (`reproduceSaved`), and two-step `Delete…`.
- Filters omitted from the toolbar (`rootId`, `frozenDefinitionId`, `model`, custom `groupBy`, custom `timezone`, and custom `pageSize`) remain available through `ReportingApi` and `CMD_READ_REPORT`.

**Unknowns, unavailables, and counts.**
- Open or unrecorded durations remain `null` (rendered as `"Unknown: not measured"`, never `0`) and are counted in `coverage.unknownDurations`.
- Percentile distributions with zero known samples return `'unavailable'` (rendered as `"Unavailable: cannot be shown"`, never `'n/a'` or `0`).
- `usage` rows report `invocations: 'not-recorded'` (rendered as `"Not recorded"`), preserve F06 `completeness` and `coverage`, render unknown cost without substituting `0`, and distinguish `reportedTotal` from `estimatedTotal` when present.
- The `usage` view's unattributed count, gap counts, and legacy pre-cutover summary remain store-wide for that folder's isolated SQLite database and sit beside the rows rather than being merged into them.

## Snapshot pinning and root drill-down joins

A report is captured once in one synchronous read transaction under a pinned cutoff (`min(range.endMs, cutoffMs)`) and frozen for its lease. Paging, drill-down, export, and save all read that snapshot so concurrent writes cannot distort pages.

Root drill-down (`drillDown`, `ReportDrillDownPanel.svelte`) returns:
- The pinned root row, its attempts, its `frozenDefinitionId` (`string | null` — runs without a frozen definition are valid and pass egress validation), outcome lineage, and root-scoped F06 usage at the report's pinned accounting revision;
- **Path-free evidence references (`evidenceRefs`)**: metadata-only rows from `artifact_lifecycle` with `al.created_at_ms < cutoff` covering `present`, `missing`, `deleted`, and `expired` states; path separators (`/` and `\`) in identifiers are scrubbed to `:` and no filesystem path or URI crosses the contract;
- **Cutoff-pinned live ACP attributions (`acpAttributions`)**: per-attempt backend/model/profile/lane metadata plus the count of `origin = 'live'` observations in `acp_observation_ledger` with `obs.observed_at_ms < cutoff` (history replays and post-cutoff observations are excluded);
- **Accepted phase handoffs (`handoffSummaries`)**: rows from `phase_handoff_records` filtered by `phr.status IN ('accepted', 'ready', 'intent', 'delivered', 'uncertain')` and `phr.created_at_ms < cutoff` — matching the real `SqliteHandoffStore` persisted statuses for approved/ready and dispatched handoffs (`ready`, `intent`, `delivered`, `uncertain`) plus legacy `'accepted'`, while excluding `waiting-approval`, `superseded`, `empty`, synthetic `rejected`, and post-cutoff handoffs;
- **Review-loop summaries (`reviewSummaries`)**: cutoff-pinned open/resolved/total finding counts and scrubbed `candidateRef` from `phase_review_loop_ledgers` (`prl.updated_at_ms < cutoff`), without review prose or paths.

Drill-down reads usage at the report's accounting revision, while F06 stores an attempt's current outcome, backend, and model rather than per-revision dimension history; an outcome recorded after capture can therefore appear in the accounting portion of lineage.

**Keeping the last complete report on screen.** In `HistoricalReportsPanel.svelte`, running a new query or re-running a saved report does **not** clear the current drill-down or send `{ op: 'close' }` for the displayed report until the replacement returns `ok: true`. If a replacement query is cancelled, hits a limit (`working-data`, `deadline-exceeded`, `snapshot-rows`), is refused, or fails, the last complete report and its live host lease remain intact for paging, drill-down, saving, and export.

## Bounds and performance

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
| Report lease | 5 minutes | `expired`, with instruction `restart-report-query` |
| Page size | 50 default, 200 max | `refused` `invalid-query` |
| Page bytes | 1 MiB (at least one row per page) | Page ends early with a cursor. |
| Range | 30 days default, 90 days max | `refused` `invalid-query` |

Working data is estimated as two bytes per UTF-16 code unit of every string value plus 64 bytes per row. On the 100,000-attempt fixture, full-range `attempt-detail` exceeds the shared 32 MiB budget and returns `limited` / `working-data` (narrow the range or filter by workflow/root).

Aggregation yields to the event loop every 8 ms; cancelling an active query via `CMD_READ_REPORT { op: 'cancelActive' }` or `AbortSignal` aborts only that router/caller's query and releases its slot and working data. Full 100,000-attempt latency measurements — including isolated warm snapshot capture latency, preserved `500 ms` (`NFR-002`) and `10 ms` (`NFR-005`) `SHOULD` target verdicts, later-page cursor `p95`, and cancellation acknowledgement — are published in [Historical reporting 100,000-attempt performance measurement](historical-reporting-measurement.md).

## Exports, active pinning, and external-file retention

An export writes a live report to an operator-chosen local file as JSON or CSV, with a manifest beside it named `<file>.manifest.json` (both created `0600` owner-only). Exports contain metadata only (`privacyProfile: "metadata-only"`): no prompt, output, log, or artifact content.

- **Destination containment**: The destination must be a local file outside the workspace's `.schegent/` store (`destination-not-local-file`, `destination-in-evidence-store`, `destination-unresolvable`, or `destination-exists` without overwrite). In the sidebar UI, the destination comes exclusively from the host's native `showSaveDialog` (`exportReportWithDialog`); the webview never sends or receives filesystem paths.
- **Caps & staging**: `100,000` rows, `64 MiB` output, `60 s` time limit (`export-rows`, `export-bytes`, `export-time`), `8 MiB` write buffer, one active export per workspace (`export-busy`). Data and manifest write to hidden sibling partials (`<file>.<exportId>.{data,manifest}.partial`), hash while streaming, sync, publish data before manifest, and remove only their own partials. Stale pending records older than 2 minutes are finalized `failed` / `host-stopped` by `reconcileExports`.
- **In-flight export root pinning**: While `exportReport` runs, `ReportingService.activeExportRootIds()` holds the live report's root IDs and exposes them through `querySqliteProtectedRunIds`, sparing those roots' session evidence from retention sweeps until the export finishes, cancels, or fails (`finally` release).
- **External-file retention boundary (`outside-managed-retention`)**: Once written, exported report files and manifests live **outside managed retention**. No retention sweep, privacy-profile change, `Schegent: Delete Run Evidence`, or deleting a saved report ever removes or edits an exported file on disk. Both the export manifest (`retention: "outside-managed-retention"`) and `HistoricalReportsPanel.svelte` / `SavedReportsSection.svelte` disclose this explicitly; see [What Schegent keeps on this machine](evidence-retention-disclosure.md).
- **JSON vs CSV profile v1**: JSON (`schegent.report-data`, version 1) is the exact format. CSV is for viewing: every field quoted, CRLF records, UTF-8 without BOM, `text:` prefix on text cells so no spreadsheet formula executes, `\u{XXXX}` escapes for control/invisible/bidi/default-ignorable/surrogate characters, `\\` for backslash, 4,096-code-point truncation with `\u{2026}[truncated]`, `number:` prefix for imprecise numbers, empty field `""` for unknown (never `0`), and transformation counts in the manifest.

## Saved reports

- `saveReport` stores a live report's canonical query and immutable manifest in SQLite (`saved_reports`).
- `rerunSavedReport` executes the saved absolute range at a new cutoff under a new `reportId` linked via `rerunOf`.
- `reproduceSavedReport` re-reads the saved cutoff and accounting revision, answering `reproduced` only when the recomputed population digest matches, or `source-no-longer-reproducible` (`calculation-version-changed`, `population-changed`, `accounting-revision-unavailable`).
- `deleteSavedReport` removes only the saved definition and manifest row in SQLite; it never touches previously exported files on disk.

## Trust, primacy, and host vs headless boundaries

| Surface | Untrusted workspace | Secondary window (non-primary) | Notes |
|---|---|---|---|
| Headless `ReportingApi` | Reads, `rerunSavedReport`, and `reproduceSavedReport` allowed; `exportReport`, `saveReport`, `deleteSavedReport`, and `reconcileExports` refused `workspace-untrusted`. | Caller-owned (no VS Code window lock). | Exact key/type check runs first (`invalid-query`), then trust check on every call. |
| Sidebar `CMD_READ_REPORT` (`read-only`) | Permitted by router; if the trusted SQLite store has not been opened yet for an untrusted folder, answers typed `accounting-unavailable`. | Permitted (read-only). | Never writes files, state, or audit rows; active-query abort is scoped per router (`WeakMap`). |
| Sidebar `CMD_MUTATE_REPORT` (`gatedConcurrent`) | Rejected before handler (`untrusted-workspace`). | Rejected before handler (`secondary-window-readonly`). | Covers `save`, `export` (host dialog), and `deleteSaved`. |

## Accessibility posture

Automated accessibility checks (`axe-core`, keyboard navigation, `aria-disabled` focus preservation during loading/saving/paging, active-column `aria-sort`, polite `role="status"` announcements, and drill-down focus restoration) verify the Historical Reports UI components. **Human screen-reader assistive-technology verification (VoiceOver, NVDA, JAWS) remains `UNTESTED` / `not observed`** and is tracked honestly in [the accessibility AT matrix](../release/accessibility-at-matrix.md) and [the interactive verification register](interactive-verification-register.md).

## Current limits

- **No backend/model filters on run-derived views**: Execution-summary, attempt-detail, failure-cause, workflow-revision, and time-series filter on run-table columns and refuse `backend`/`model` as `unsupported-dimension`; use the `usage` view to filter by backend or model.
- **Invocations not recorded**: Backends do not record an invocation count in reporting rows (`invocations: 'not-recorded'`).
- **First-page and sliced-gap `SHOULD` targets**: On the 100,000-attempt `darwin-arm64` fixture, first-page `execution-summary` `p95` (`522.09 ms`) and sliced event-loop gap `p95` (`16.22 ms`) currently exceed the `500 ms` (`NFR-002`) and `10 ms` (`NFR-005`) `SHOULD` targets due to the single synchronous snapshot capture (`p50: 294.29 ms`) and sliced aggregation work, while later-page `p95` (`0.1299 ms`) and cancellation (`8.29 ms`) pass comfortably; see [historical-reporting-measurement.md](historical-reporting-measurement.md).
- **Human AT verification**: Screen-reader observation remains `UNTESTED` (automated checks provide risk reduction, not human AT conformance).
