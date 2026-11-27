# Legacy `Pipeline` Compatibility Caller Inventory (`FR-R7-14` / `14-21`, `FR-R8-04` / `04-04`)

**Measured**: 2026-11-25 (refreshed from 2026-11-23 baseline at `738554ed`) · **Scope**: non-test production source files in `repo/src/` and `repo/webview-ui/src/`

Schegent's public catalog model has two definition kinds: **Phase** and **Workflow**. Historical compatibility surfaces from the earlier `Pipeline` model (`PipelineDefinition`, `PipelineDef`, `PipelineConfig`, `WorkflowRun.pipeline`, `pipelineId`, `schegent.defaultPipelineId`, `pipelineCatalog` / `availablePipelines` snapshot slices, `PipelineBuilder.svelte`, and the `PipelineBuilderEditors/` directory) still exist across both host and webview code so persisted Runs, historical entries, and settings remain readable without breaking existing workspaces (while `kind: Pipeline` process-YAML imports are retired with `unsupported-kind` per `docs/hard-rules.md` rule 48).

This document records a dated, reproducible inventory of those compatibility callers before any future retirement work is scheduled. No speculative rewrites or renames were performed in `FR-R7-14` or `FR-R8-04`; persisted compatibility is continuously verified in `tests/integration/boundary-compatibility-matrix.test.ts`.

<!-- Source: src/contracts/pipeline-definitions.ts -->
<!-- Source: src/config/pipeline-config.ts -->
<!-- Source: src/config/pipeline-snapshot.ts -->
<!-- Source: src/ui/sidebar/pipeline-catalog-projection.ts -->
<!-- Source: webview-ui/src/components/PipelineBuilder.svelte -->
<!-- Source: webview-ui/src/lib/resolve-pipeline-name.ts -->

---

## 1. Summary Counts (Refreshed 2026-11-25 · FR-R8-04 `04-04`)

Scan scope: every non-test `.ts`, `.svelte`, `.js`, and `.mjs` file under `src/` and `webview-ui/src/` (excluding `__tests__/`, `*.test.*`, and `*.spec.*`), stripping `//` and `/* ... */` comments before matching legacy `Pipeline` compatibility symbols (`PipelineDefinition`, `PipelineDef`, `PipelineConfig`, `PipelineBuilder`, `pipelineCatalog`, `availablePipelines`, `defaultPipelineId`, `pipelineId`, `PipelineSnapshot`, `resolvePipelineCatalog`, `PipelineCatalog`, `pipeline-config`, `pipeline-catalog`, `pipeline-definitions`, `pipeline-snapshot`, `resolvePipelineName`, `resolve-pipeline-name`, `CMD_LAUNCH_PIPELINE`, `cmd-launch-pipeline`, and `.pipeline` property access).

| Tree | Non-test files scanned | Code-bearing legacy `Pipeline` caller files | Path-named only (0 code hits) | Total files with `pipeline` in path |
|---|---:|---:|---:|---:|
| **Host (`src/`)** | 1,066 (was 1,041 at `738554ed`) | **123** (was 121; +2 from Round 8 workflow/atomic-admission compatibility shims) | 3 | 13 |
| **Webview (`webview-ui/src/`)** | 292 (was 290 at `738554ed`) | **35** (unchanged) | 36 | 44 |
| **Combined** | **1,358** (was 1,331) | **158** (was 156) | **39** | **57** |

The 36 path-named-only webview files are modern Phase/Workflow/Model editor modules that carry zero code-body references to legacy `Pipeline` symbols and appear in path scans only because they reside under `webview-ui/src/components/PipelineBuilderEditors/`.

---

## 2. Breakdown by Compatibility Surface Category

Files referencing more than one surface appear in each applicable row:

| Compatibility surface category | Representative identifiers / fields | Host (`src/`) files | Webview (`webview-ui/src/`) files |
|---|---|---:|---:|
| **Run, queue & frozen snapshot fields** | `WorkflowRun.pipeline`, `pipelineId`, `defaultPipelineId`, `PipelineSnapshot`, `pipeline-snapshot` | 93 | 23 |
| **Definition, config & catalog layer** | `PipelineDefinition`, `PipelineDef`, `PipelineConfig`, `PipelineCatalog`, `resolvePipelineCatalog`, `pipeline-config`, `pipeline-definitions` | 62 | 10 |
| **IPC snapshot & projection** | `pipelineCatalog`, `availablePipelines`, `pipeline-catalog-projection`, `workflow-pipeline-refs`, `cmd-launch-pipeline` | 21 | 12 |
| **UI builder & display helpers** | `PipelineBuilder`, `resolvePipelineName`, `resolve-pipeline-name` | 0 | 3 |

---

## 3. Host (`src/`) Subsystem Breakdown

### 3.1 Code-bearing caller files by subsystem (123 files)

| Subsystem | Caller files | Primary compatibility role |
|---|---:|---|
| `src/contracts/` | 21 | Persisted Run/queue/history/IPC/schema compatibility types (`pipeline-definitions.ts`, `sidebar-ipc.ts`, `run-request.ts`, `catalog-store.ts`) |
| `src/ui/` | 20 | Snapshot projection (`pipeline-catalog-projection.ts`, `workflow-pipeline-refs.ts`, `workflow-definition-pipeline-refs.ts`), sidebar command handlers |
| `src/config/` | 15 | Legacy pipeline catalog resolution, binding/definition validation, and frozen `pipeline-snapshot.ts` construction |
| `src/controller/` | 9 | Phase execution reading frozen `WorkflowRun.pipeline` snapshots and phase metadata |
| `src/state/` | 9 | Forward-only workspace-state migrators, Run map persistence, and history records carrying `pipelineId` |
| `src/activation/` | 8 | Stage 2 wiring, catalog loading, and legacy `defaultPipelineId` / command compatibility adapters |
| `src/services/workflow-execution/` | 8 | Bridge between connected Workflow runs and frozen per-attempt `WorkflowRun.pipeline` snapshots |
| `src/services/phase-log/` | 6 | Diagnostics and phase-log directory keys retaining `<pipeline>` path segments |
| `src/commands/` | 5 | Command-palette entry points passing run/pipeline compatibility arguments |
| `src/services/process-yaml/` | 4 | Process-YAML export/preflight modules importing shared model/port helper types from `pipeline-config-loader.ts` and `pipeline-definitions.ts` (`kind: Pipeline` imports are retired with `unsupported-kind`) |
| `src/runner/` | 3 | Prompt builder and runner invocation context carrying `PhaseDef` from `pipeline-config.ts` |
| `src/audit/` | 2 | Audit/diagnostics helpers formatting pipeline-scoped metadata |
| `src/queue/` | 2 | Queue task rows carrying optional compatibility `pipelineId` references |
| `src/services/run-request/` | 2 | Run-request validation bridging legacy launch requests to frozen Workflow closures |
| `src/services/phase-context/` | 1 | Phase-handoff publisher resolving workflow/pipeline context metadata |
| `src/headless/` | 1 | Headless run inspection compatibility export |
| Top-level `src/services/*.ts` | 7 | `effective-limits.ts`, `guarded-run-service.ts`, `history-recorder.ts`, `run-driver.ts`, `run-planned-total.ts`, `spend-bound-watcher.ts`, `workflow-run-factory.ts` |

### 3.2 Host path-named modules (13 files)

- `src/config/pipeline-binding-validator.ts`
- `src/config/pipeline-catalog.ts`
- `src/config/pipeline-config-loader.ts`
- `src/config/pipeline-config.ts`
- `src/config/pipeline-definition-validator.ts`
- `src/config/pipeline-snapshot.ts`
- `src/contracts/pipeline-definitions.ts`
- `src/headless/pipeline-run-api.ts` (path-named compatibility entry point; 0 code-body hits)
- `src/ui/sidebar/commands/cmd-launch-pipeline.ts` (path-named compatibility handler; 0 code-body hits)
- `src/ui/sidebar/pipeline-catalog-projection.ts`
- `src/ui/sidebar/workflow-definition-pipeline-refs.ts`
- `src/ui/sidebar/workflow-pipeline-ref-source.ts`
- `src/ui/sidebar/workflow-pipeline-refs.ts`

---

## 4. Webview (`webview-ui/src/`) Subsystem Breakdown

### 4.1 Code-bearing caller files by subsystem (35 files)

| Subsystem | Caller files | Primary compatibility role |
|---|---:|---|
| `webview-ui/src/lib/` | 13 | Snapshot types, history row formatting, run composition, IPC wrappers, `resolve-pipeline-name.ts` |
| `webview-ui/src/components/PipelineBuilderEditors/` | 7 | Catalog/workflow editors reading compatibility references (`workflow-catalog-state.ts`, `workflow-flow-view.ts`, `WorkflowNodeInspector.svelte`, `WorkflowCatalogView`, etc.) |
| `webview-ui/src/components/` (top-level) | 3 | `PipelineBuilder.svelte` shell and history/queue components reading `pipelineId` labels |
| `webview-ui/src/components/drilldown/` | 3 | Queue/run detail views resolving display names for historical runs |
| `webview-ui/src/components/WorkflowRun/` | 3 | Active run views inspecting frozen `pipeline` phase lists |
| `webview-ui/src/components/PhaseLogFeed/` | 2 | Phase-log diagnostics path labels |
| `webview-ui/src/components/RunLauncher/` | 1 | Launcher compatibility display helper |
| `webview-ui/src/components/Runs/` | 1 | Run summary row label |
| `webview-ui/src/components/settings/` | 1 | `schegent.defaultPipelineId` setting surface |
| `webview-ui/src/dashboard/` | 1 | Route loader importing `PipelineBuilder.svelte` |

### 4.2 Webview directory-name residual (`PipelineBuilderEditors/`)

42 files live inside `webview-ui/src/components/PipelineBuilderEditors/` (plus `PipelineBuilder.svelte` and `lib/resolve-pipeline-name.ts` = 44 path-named files). Only 7 files inside `PipelineBuilderEditors/` actually reference legacy `Pipeline` compatibility identifiers in code; the remaining 35 files inside that folder are pure Phase/Workflow/Model editor components whose legacy naming is strictly structural.

---

## 5. Prerequisites Before Retiring Legacy `Pipeline` Names

Retiring any of these surfaces is a separate scoped decision, not a mechanical rename. Before deleting or breaking legacy `Pipeline` compatibility symbols, satisfy each prerequisite below:

1. **Persisted Run & history migration**: Historical `WorkflowRun.pipeline` snapshots and `pipelineId` fields in workspace state, SQLite `operational_runs` / `operational_tasks` / `history`, and `.schegent/sessions/<runId>/diagnostics/<pipeline>/` paths must either remain readable via a dedicated legacy deserializer or be migrated with a forward-only schema bump and verified pre-upgrade backup rollback test.
2. **Settings & manifest deprecation**: `schegent.defaultPipelineId` in `package.json` must have a documented deprecation/removal notice and safe read-ignore behavior for existing User/Workspace settings files.
3. **IPC & snapshot contract bump**: Removing `pipelineCatalog` and `availablePipelines` from `SidebarSnapshot` and `SUPPRESSIBLE_SNAPSHOT_SLICES` requires updating the host/webview IPC schema, `snapshot-transport.ts`, `snapshot-merge.ts`, and `webview-snapshot-cost-measurement.md`.
4. **Process-YAML import compatibility**: Feature 263 (`docs/hard-rules.md` rule 48) already retired `kind: Pipeline` process-YAML imports with explicit refusal code `unsupported-kind`; decide when to retire the remaining legacy refusal/compatibility parser shims under `src/services/process-yaml/` (`preflight-service.ts`, `workflow-document.ts`) while keeping operator guidance for old files clear.
5. **Coordinated UI directory rename**: Renaming `PipelineBuilder.svelte` and `PipelineBuilderEditors/` (44 files) should be scheduled in an isolated refactor commit once active builder changes settle, avoiding mixed behavioral + path-move diffs.
