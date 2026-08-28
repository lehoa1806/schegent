# API and command reference

This is the exhaustive user-facing reference for every command surface shipped by Schegent 0.2.0. Use the Command Palette sections for ordinary operation and the webview boundary sections when integrating or diagnosing the sidebar and Dashboard. This is the single authority for that surface; [why there is one reference here and not two](README.md) records the consolidation.

Schegent 0.2.0 exposes a VS Code extension surface, not a network service. The production bundle has one entry point, `src/extension.ts`, and `package.json` declares `main` but no `bin` or `exports`. There is no production HTTP server, route table, REST endpoint, GraphQL endpoint, WebSocket server, URI handler, or shipped Schegent shell command. Both shipped webviews set `connect-src 'none'`. The only listening HTTP server in the repository serves built webviews on `127.0.0.1:4173` during visual tests.

<!-- Source: package.json -->
<!-- Source: esbuild.config.mjs -->
<!-- Source: tests/visual/serve-built-webviews.mjs -->
<!-- Source: playwright.config.ts -->
<!-- Source: src/ui/sidebar/csp.ts -->
<!-- Source: .vscodeignore -->

## Access-control vocabulary

Schegent has no user account, login, API key, role, tenant, or network authentication layer. Its relevant guards are local capabilities:

- **Direct VS Code commands** have the individual guards documented below, and one gate above all of them: every one of the 30 registrations goes through `registerGuardedCommand`, which classifies the ID from `src/contracts/entry-point-dispositions.ts`. The 23 `mutating` IDs are wrapped in a re-read of `vscode.workspace.isTrusted` that runs on **every invocation** — not a boolean captured at registration, because a command outlives its registration and can be invoked after trust is granted — and a refusal warns the operator, logs once at info, and returns `undefined` rather than throwing. The 7 `read-only` IDs are registered unwrapped, so reads pay nothing. An ID in neither map does not type-check at the call site and throws at registration if cast. Until FR-R3-136 (2026-08-28) this line read "none of the 27 registrations checks `vscode.workspace.isTrusted` directly", and it was accurate: the sidebar router was the only gate, so the palette, a task, and any other installed extension reached every mutation.
- **M — mutation gate:** all 46 metadata-classified webview mutations are rejected unless `vscode.workspace.isTrusted === true` and this window holds authoritative workspace primacy. Trust is checked first. Missing callbacks, thrown checks, and any non-`true` result fail closed. Accepted mutations are serialized; a repeated correlation ID replays its acknowledgement for one hour, with at most 1,000 cached acknowledgements.
- **C — catalog content gate:** some catalog lifecycle handlers additionally require the `phases` capability for Phase authoring and the `retryConditions` capability when a newly supplied Phase body declares that field. These checks occur after the M gate and stale-draft check.
- **P — primary read gate:** `CMD_READ_METRICS` is read-only but independently requires window primacy because it scans shared archive state.
- **R — read/UI gate:** no trust or primacy check after transport validation.

Every webview command must be an object with a known `type`, a non-empty `correlationId` of at most 64 characters, and the command-specific payload below. The production ingress is `validateInboundMessage`, not the discriminator-only `COMMAND_GUARDS` registry despite a stale source comment claiming otherwise. Each command has a runtime validator; exceptions to strict object and unexpected-field rejection are recorded under the table. Invalid messages are logged and dropped by both webview hosts without a `CMD_ACK`.

Before a run containing a Phase with `sideEffects: git` or unrestricted permission is created, the host requires a modal approval tied to the exact mutation-plan fingerprint and Phase list. Only `Approve This Run` grants the receipt, and dispatch checks it again. This execution approval is separate from command routing.

<!-- Source: src/ui/sidebar/message-router.ts -->
<!-- Source: src/ui/sidebar/commands/primacy-gate.ts -->
<!-- Source: src/ui/sidebar/mutation-command-executor.ts -->
<!-- Source: src/contracts/runtime-validators.ts -->
<!-- Source: src/contracts/validators/shared.ts -->
<!-- Source: src/contracts/sidebar-ipc.ts -->
<!-- Source: src/ui/sidebar/sidebar-view-provider.ts -->
<!-- Source: src/ui/dashboard/dashboard-panel.ts -->
<!-- Source: src/extension.ts -->
<!-- Source: src/activation/git-approval.ts -->
<!-- Source: src/services/workflow-run-factory.ts -->
<!-- Source: src/services/run-driver.ts -->

## Contributed VS Code commands

These 22 commands appear in the Command Palette. A question mark means that the field or whole argument is optional.

| Command and title | Accepted argument | Behavior and guard | Source |
|---|---|---|---|
| `schegent.auto` — Schegent: Run Autonomous Workflow | `{ description?, featureDir?, pipelineId?, queueId?, position?, startIntent?, callerKind?, callerId? }?` | Prompts for a missing description, defaults `queueId` to `default`, `startIntent` to immediate operator start, and `callerKind` to `human`. Run admission validates input and refuses a fresh foreign lock or paused queue. Classified `mutating` in `entry-point-dispositions.ts`, so an untrusted workspace refuses it at the point of effect; no direct primacy check. | <!-- Source: package.json --><!-- Source: src/commands/auto.ts --><!-- Source: src/commands/enqueue.ts --> |
| `schegent.schedule` — Schegent: Enqueue Feature Request | `{ description?, pipelineId?, queueId?, position?, scheduledStartAt? }?` | Prompts for missing Pipeline/description. Missing `scheduledStartAt` becomes `Date.now()`. Run admission refuses invalid input, a fresh foreign lock, a paused queue, or a target over the seven-day horizon. | <!-- Source: package.json --><!-- Source: src/commands/schedule.ts --><!-- Source: src/services/guarded-run-service.ts --> |
| `schegent.resume` — Schegent: Resume Paused or Failed Workflow | `prompt?: string` | Calls `tryAcquire`; then resumes only the sole paused/failed Run. Multiple candidates are refused. | <!-- Source: package.json --><!-- Source: src/activation/ui-wiring.ts --><!-- Source: src/commands/resume.ts --> |
| `schegent.cancel` — Schegent: Cancel In-Flight Workflow | `{ taskId?: string }?` | With an ID, cancels that Task. Without one, cancels only the sole running Run. Classified `mutating` in `entry-point-dispositions.ts`, so an untrusted workspace refuses it at the point of effect; no direct primacy check. | <!-- Source: package.json --><!-- Source: src/commands/cancel.ts --><!-- Source: src/activation/ui-wiring.ts --> |
| `schegent.reset` — Schegent: Reset Workspace State | none | Shows the host confirmation dialog, then runs the staged workspace reset. Classified `mutating` in `entry-point-dispositions.ts`, so an untrusted workspace refuses it at the point of effect; no direct primacy check. Registered in Stage 1, before any workspace-bound service exists, so the guard imports only the pure decision and the frozen disposition map. The sidebar variant has the M gate and a prior webview confirmation. | <!-- Source: package.json --><!-- Source: src/extension.ts --><!-- Source: src/commands/reset.ts --> |
| `schegent.showAuditLog` — Schegent: Show Audit Log | none | Opens `.schegent/audit.log`; reports that no log exists on read failure. Classified `read-only`, so it is registered unwrapped and stays available in an untrusted workspace. No primacy check. | <!-- Source: package.json --><!-- Source: src/commands/show-audit.ts --> |
| `schegent.exportAuditLog` — Schegent: Export Metadata-Only Audit | none | Opens a save dialog and exports schema-v3 metadata/count fields only. Classified `read-only`, so it is registered unwrapped and stays available in an untrusted workspace. No primacy check. | <!-- Source: package.json --><!-- Source: src/commands/export-audit.ts --> |
| `schegent.pauseQueue` — Schegent: Pause Queue | `{ reason?: string }?` | The direct command uses only `reason` and addresses the default queue. Requires authoritative primacy. | <!-- Source: package.json --><!-- Source: src/commands/queue-ops.ts --><!-- Source: src/activation/ui-wiring.ts --> |
| `schegent.resumeQueue` — Schegent: Resume Queue | none | Resumes the default queue. Requires authoritative primacy. | <!-- Source: package.json --><!-- Source: src/commands/queue-ops.ts --> |
| `schegent.retryQueuedItem` — Schegent: Retry Queued Item | non-empty `id: string` or `{ id: string }` | Retries the addressed item. Requires authoritative primacy. | <!-- Source: package.json --><!-- Source: src/commands/queue-ops.ts --> |
| `schegent.moveQueuedItemUp` — Schegent: Move Queued Item Up | non-empty `id: string` or `{ id: string }` | Moves the addressed pending item up. Requires authoritative primacy. | <!-- Source: package.json --><!-- Source: src/commands/queue-ops.ts --> |
| `schegent.moveQueuedItemDown` — Schegent: Move Queued Item Down | non-empty `id: string` or `{ id: string }` | Moves the addressed pending item down. Requires authoritative primacy. | <!-- Source: package.json --><!-- Source: src/commands/queue-ops.ts --> |
| `schegent.clearCompleted` — Schegent: Clear Completed Queue Items | none | Clears completed items. Requires authoritative primacy. | <!-- Source: package.json --><!-- Source: src/commands/queue-ops.ts --> |
| `schegent.clearFailed` — Schegent: Clear Failed Queue Items | none | Clears failed items. Requires authoritative primacy. | <!-- Source: package.json --><!-- Source: src/commands/queue-ops.ts --> |
| `schegent.rerunFromHistory` — Schegent: Rerun From History | `{ runId: string, force?: boolean }` | Requires primacy. Replays the stored full description; a legacy entry without one requires `force: true` and then replays its truncated preview. | <!-- Source: package.json --><!-- Source: src/commands/rerun-from-history.ts --> |
| `schegent.showActiveRun` — Schegent: Show Active Run | `{ id?, runId?, source?: 'queue' or 'history' or 'sidebar' }?` | Opens the Schegent Activity Bar and emits an informational notice. Classified `read-only`, so it is registered unwrapped and stays available in an untrusted workspace. No primacy check. | <!-- Source: package.json --><!-- Source: src/commands/show-active-run.ts --> |
| `schegent.openDashboard` — Schegent: Open Dashboard | any value; ignored | Refuses when no workspace folder is open, otherwise opens the Dashboard. Classified `read-only`, so it is registered unwrapped and stays available in an untrusted workspace. No primacy check. | <!-- Source: package.json --><!-- Source: src/commands/open-dashboard.ts --> |
| `schegent.retryActiveRun` — Schegent: Retry Active Run | any value; ignored | Requires primacy. Prefers the sole paused/failed active Run, then a recent retryable queue item, then eligible history. | <!-- Source: package.json --><!-- Source: src/commands/retry-active-run.ts --> |
| `schegent.redetectClaudeTransport` — Schegent: Re-detect Claude CLI prompt transport | none | Informational no-op: the current Claude path always streams its prompt over stdin. Classified `read-only`, so it is registered unwrapped and stays available in an untrusted workspace. No primacy check. | <!-- Source: package.json --><!-- Source: src/activation/ui-wiring.ts --> |
| `schegent.verifyAuditChain` — Schegent: Verify Audit Chain | none | Walks `.schegent/audit.log`'s per-entry digest chain and names the first break. Detection, not prevention: the chain head sits on the same disk as the log. Classified `read-only`, so it is registered unwrapped and stays available in an untrusted workspace. No primacy check. **Omitted from this table until FR-R3-127**, which is why `tests/lint/documented-commands-exist.test.ts` now holds this page in both directions. | <!-- Source: package.json --><!-- Source: src/commands/verify-audit-chain.ts --> |
| `schegent.exportRunEvidence` — Schegent: Export Run Evidence | `runId?: string` | Prompts for the Run id when none is passed, then for a destination folder, and refuses a destination inside `.schegent/`. Writes an archive plus a manifest of what it contains and what it omits. Classified `read-only`, so it is registered unwrapped and stays available in an untrusted workspace. No primacy check. | <!-- Source: package.json --><!-- Source: src/commands/evidence-commands.ts --><!-- Source: src/services/evidence-export.ts --> |
| `schegent.deleteRunEvidence` — Schegent: Delete Run Evidence | `runId?: string` | Prompts for the Run id when none is passed, then confirms modally. Refuses rather than racing a live writer, and reports what it removed **and** what it could not. Audited as `evidence-deleted`. Classified `mutating` in `entry-point-dispositions.ts`, so an untrusted workspace refuses it at the point of effect; no direct primacy check. | <!-- Source: package.json --><!-- Source: src/commands/evidence-commands.ts --><!-- Source: src/services/evidence-delete.ts --> |

<!-- Source: package.json -->
<!-- Source: src/activation/ui-wiring.ts -->

## Registered-only VS Code commands

These eight IDs can be invoked through `vscode.commands.executeCommand`, but they are not contributed to the Command Palette. Palette absence is not authorization: `executeCommand` reaches a registered command from a task, from another installed extension, and from this extension's own webview alike. That is why the trust check on each row below sits at the point of effect rather than at contribution, and why the guard is code rather than an `enablement` clause.

| Command | Accepted argument | Behavior and guard | Source |
|---|---|---|---|
| `schegent.enqueue` | `{ queueId: string, description?, featureDir?, pipelineId?, position?, startIntent?, callerKind?, callerId? }` | Pure enqueue followed by drain of the named queue. Blank/absent queue IDs are refused. Run admission checks validation, a fresh foreign lock, pause state, and schedule horizon. Classified `mutating` in `entry-point-dispositions.ts`, so an untrusted workspace refuses it at the point of effect; no direct primacy check. | <!-- Source: src/activation/ui-wiring.ts --><!-- Source: src/commands/enqueue.ts --><!-- Source: src/services/guarded-run-service.ts --> |
| `schegent.startQueue` | `{ queueId?, startIntent?: { startMode: 'now' or 'scheduled' or 'cancel-schedule', scheduledStartAt?, source: 'operator-restart' } }?` | Applies an optional start/schedule intent or directly drains the named/default queue. Classified `mutating`, so an untrusted workspace refuses it at the point of effect; no direct primacy check. | <!-- Source: src/activation/ui-wiring.ts --><!-- Source: src/commands/start-queue.ts --><!-- Source: src/services/guarded-run-service.ts --> |
| `schegent.restartCanceledTask` | `{ taskId?: string }?` | Requires a non-empty Task ID and `canceled` state. Classified `mutating`, so an untrusted workspace refuses it at the point of effect; no direct primacy check. | <!-- Source: src/activation/ui-wiring.ts --><!-- Source: src/commands/restart-canceled-task.ts --> |
| `schegent.clearAll` | none | Requires primacy, cancels active work with a bounded acknowledgement wait, clears all queues atomically, and clears watchdog backoff. | <!-- Source: src/activation/ui-wiring.ts --><!-- Source: src/commands/clear-all.ts --> |
| `schegent.retryPhaseNow` | `queueId?: string` | Requires primacy; a missing/non-string ID asks the controller to resolve a sole Run. | <!-- Source: src/activation/ui-wiring.ts --><!-- Source: src/commands/retry-phase-now.ts --> |
| `schegent.pausePhase` | `queueId?: string` | Pauses the addressed active Phase; omission is allowed only when the controller can resolve one Run. Classified `mutating`, so an untrusted workspace refuses it at the point of effect; no direct primacy check. | <!-- Source: src/activation/ui-wiring.ts --> |
| `schegent.resumePhase` | `prompt?: string, queueId?: string` | Resumes the addressed active Phase; omission relies on sole-Run resolution. Classified `mutating`, so an untrusted workspace refuses it at the point of effect; no direct primacy check. | <!-- Source: src/activation/ui-wiring.ts --> |
| `schegent.restartPhase` | `queueId?: string` | Restarts the addressed active Phase; omission relies on sole-Run resolution. Classified `mutating`, so an untrusted workspace refuses it at the point of effect; no direct primacy check. | <!-- Source: src/activation/ui-wiring.ts --> |

## Webview command boundary

The authoritative schema version is `3`. The table is exhaustive: `COMMAND_TYPES` contains exactly these 61 inbound literals. Payload notation describes the runtime boundary; `?` means optional. All rows also require the shared `type` and `correlationId` envelope.

| Inbound command | Payload | Guard | Source |
|---|---|---|---|
| `CMD_START` | `{ description: string, pipelineId?, queueId?, position?: non-negative integer, startIntent? }` | M | <!-- Source: src/contracts/sidebar-ipc.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_CANCEL` | `{ taskId: string }` | M | <!-- Source: src/contracts/sidebar-ipc.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_RESUME` | no payload at runtime | M | <!-- Source: src/contracts/sidebar-ipc.ts --><!-- Source: src/contracts/runtime-validators.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_RESET` | `{ confirmed: true }` | M | <!-- Source: src/contracts/sidebar-ipc.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_REMOVE_QUEUE_ITEM` | `{ id: string, confirmed: true }` | M | <!-- Source: src/contracts/sidebar-ipc.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_OPEN_AUDIT_LOG` | no payload | R | <!-- Source: src/contracts/sidebar-ipc.ts --> |
| `CMD_RETRY_QUEUE_ITEM` | `{ id: string }` | M | <!-- Source: src/contracts/sidebar-ipc.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_MOVE_QUEUE_ITEM_UP` | `{ id: string }` | M | <!-- Source: src/contracts/sidebar-ipc.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_MOVE_QUEUE_ITEM_DOWN` | `{ id: string }` | M | <!-- Source: src/contracts/sidebar-ipc.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_CLEAR_COMPLETED` | no payload | M | <!-- Source: src/contracts/sidebar-ipc.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_CLEAR_FAILED` | no payload | M | <!-- Source: src/contracts/sidebar-ipc.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_PAUSE_QUEUE` | optional `{ queueId?, reason? }` | M | <!-- Source: src/contracts/sidebar-ipc.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_RESUME_QUEUE` | optional `{ queueId? }` at runtime | M | <!-- Source: src/contracts/sidebar-ipc.ts --><!-- Source: src/contracts/runtime-validators.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_OPEN_DASHBOARD` | no payload | R | <!-- Source: src/contracts/sidebar-ipc.ts --> |
| `CMD_RETRY_ACTIVE_RUN` | no payload | M | <!-- Source: src/contracts/sidebar-ipc.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_RERUN_FROM_HISTORY` | `{ runId: string, force?: boolean }` | M | <!-- Source: src/contracts/sidebar-ipc.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_OPEN_QUEUE_ITEM_DETAILS` | `{ id: string }` | R | <!-- Source: src/contracts/sidebar-ipc.ts --> |
| `CMD_OPEN_HISTORY_ITEM_DETAILS` | `{ id: string }` | R | <!-- Source: src/contracts/sidebar-ipc.ts --> |
| `CMD_SAVE_MODELS` | `{ models: Record<string, string[]>, expectedRevision?: string, mutation?: { kind: 'manual-edit' or 'import-package' } }` | M | <!-- Source: src/contracts/sidebar-ipc.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_SAVE_DEFINITION_DRAFT` | `{ kind, id, expectedDraftVersion, body, note? }` | M + C(`phases`) for Phase; also C(`retryConditions`) if its body declares that field | <!-- Source: src/contracts/sidebar-ipc/catalog-lifecycle.ts --><!-- Source: src/contracts/catalog-lifecycle.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --><!-- Source: src/ui/sidebar/commands/cmd-catalog-lifecycle.ts --> |
| `CMD_PUBLISH_DEFINITION` | `{ kind, id, expectedDraftVersion }` | M + C(`phases`) for Phase | <!-- Source: src/contracts/sidebar-ipc/catalog-lifecycle.ts --><!-- Source: src/contracts/catalog-lifecycle.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --><!-- Source: src/ui/sidebar/commands/cmd-catalog-lifecycle.ts --> |
| `CMD_DEACTIVATE_DEFINITION` | `{ kind, id, expectedDraftVersion }` | M | <!-- Source: src/contracts/sidebar-ipc/catalog-lifecycle.ts --><!-- Source: src/contracts/catalog-lifecycle.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_RESTORE_DEFINITION_VERSION` | `{ kind, id, expectedDraftVersion, fromVersionId }` | M + C(`phases`) for Phase; no retry-condition re-check | <!-- Source: src/contracts/sidebar-ipc/catalog-lifecycle.ts --><!-- Source: src/contracts/catalog-lifecycle.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --><!-- Source: src/ui/sidebar/commands/cmd-catalog-lifecycle.ts --> |
| `CMD_DISCARD_DEFINITION_DRAFT` | `{ kind, id, expectedDraftVersion }` | M | <!-- Source: src/contracts/sidebar-ipc/catalog-lifecycle.ts --><!-- Source: src/contracts/catalog-lifecycle.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_PUBLISH_PACKAGE` | `{ layers: [{ kind, definitions: [{ id, body }], expectedRevision }] }` | M + C(`phases`) when a Phase layer exists; also C(`retryConditions`) when a Phase body declares it | <!-- Source: src/contracts/sidebar-ipc/catalog-lifecycle.ts --><!-- Source: src/contracts/catalog-lifecycle.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --><!-- Source: src/ui/sidebar/commands/cmd-catalog-lifecycle.ts --> |
| `CMD_READ_DEFINITION_VERSION` | `{ kind, id, versionId }` | R | <!-- Source: src/contracts/sidebar-ipc/catalog-history.ts --> |
| `CMD_SAVE_GENERAL_SETTINGS` | `{ updates: Record<string, unknown> }` | M | <!-- Source: src/contracts/sidebar-ipc.ts --><!-- Source: src/config/general-settings.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_RETRY_PHASE_NOW` | `{ queueId: string }` | M | <!-- Source: src/contracts/sidebar-ipc/run-controls.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_PAUSE_PHASE` | `{ queueId: string }` | M | <!-- Source: src/contracts/sidebar-ipc/run-controls.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_RESUME_PHASE` | `{ queueId: string, prompt?: string }` | M | <!-- Source: src/contracts/sidebar-ipc/run-controls.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_RESTART_PHASE` | `{ queueId: string, phaseId: string }` | M | <!-- Source: src/contracts/sidebar-ipc/run-controls.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_SKIP_PHASE` | `{ queueId: string, phaseId: string }` | M | <!-- Source: src/contracts/sidebar-ipc/run-controls.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_DISABLE_PHASE` | `{ queueId: string, phaseId: string }` | M | <!-- Source: src/contracts/sidebar-ipc/run-controls.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_ENABLE_PHASE` | `{ queueId: string, phaseId: string }` | M | <!-- Source: src/contracts/sidebar-ipc/run-controls.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_REMOVE_TASK_PHASE` | `{ taskId: string, phaseId: string, confirmed: true }` | M | <!-- Source: src/contracts/sidebar-ipc/run-controls.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_CREATE_QUEUE` | `{ name: string }` | M | <!-- Source: src/contracts/sidebar-ipc/queue.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_RENAME_QUEUE` | `{ queueId: string, name: string }` | M | <!-- Source: src/contracts/sidebar-ipc/queue.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_DELETE_QUEUE` | `{ queueId: string, confirmed?: true }` | M | <!-- Source: src/contracts/sidebar-ipc/queue.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_SAVE_QUEUE_SETTINGS` | `{ globalConcurrencyCap: integer 1–20, defaultQueueId: string }` | M | <!-- Source: src/contracts/sidebar-ipc/queue.ts --><!-- Source: src/contracts/validators/queue-management.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_MOVE_TASK` | `{ taskId: string, targetQueueId: string, position?: non-negative integer }` | M | <!-- Source: src/contracts/sidebar-ipc/queue.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_MODIFY_TASK` | `{ taskId: string, description: string }` | M | <!-- Source: src/contracts/sidebar-ipc/run-controls.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_REORDER_TASK` | `{ taskId: string, newPosition: non-negative integer }` | M | <!-- Source: src/contracts/sidebar-ipc/run-controls.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_RESTART_CANCELED_TASK` | `{ taskId: string }` | M | <!-- Source: src/contracts/sidebar-ipc/run-controls.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_READ_PHASE_LOG` | `{ selection: { queueId, taskId, pipelineId, phaseId, iterationN?: positive integer or null } }`; omission becomes `null` | R | <!-- Source: src/contracts/sidebar-ipc/phase-log.ts --><!-- Source: src/contracts/validators/phase-log.ts --> |
| `CMD_START_PHASE_LOG_TAIL` | `{ selection: { queueId, taskId, pipelineId, phaseId, iterationN: integer } }` | R | <!-- Source: src/contracts/sidebar-ipc/phase-log.ts --> |
| `CMD_STOP_PHASE_LOG_TAIL` | `{ sessionId: string }` | R | <!-- Source: src/contracts/sidebar-ipc/phase-log.ts --> |
| `CMD_OPEN_VERBOSE_SETTING` | no payload | R | <!-- Source: src/contracts/sidebar-ipc.ts --> |
| `CMD_RESOLVE_AUDIT_POINTER` | `{ runId: string }` | R | <!-- Source: src/contracts/sidebar-ipc/history-evidence.ts --> |
| `CMD_SET_PHASE_BREAKPOINT` | `{ queueId: string, runId: string, phaseId: string }` | M | <!-- Source: src/contracts/sidebar-ipc/run-controls.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_CLEAR_PHASE_BREAKPOINT` | `{ queueId: string, runId: string, phaseId: string }` | M | <!-- Source: src/contracts/sidebar-ipc/run-controls.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_START_QUEUE` | no payload, `{}`, or `{ queueId?, startIntent? }` | M | <!-- Source: src/contracts/sidebar-ipc.ts --><!-- Source: src/contracts/start-intent-types.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_CLEAR_ALL` | no payload or `{}` | M | <!-- Source: src/contracts/sidebar-ipc.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_SET_CONFIRM_SUPPRESSION` | `{ actionKey: string, suppressed: boolean }`; the handler's closed key set is below | M | <!-- Source: src/contracts/sidebar-ipc.ts --><!-- Source: src/ui/sidebar/commands/cmd-set-confirm-suppression.ts --><!-- Source: src/state/confirm-suppression.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_DISMISS_MIGRATION_NOTICE` | no payload; performs an idempotent persisted UX-state write but is deliberately metadata-classified as a read | R | <!-- Source: src/contracts/sidebar-ipc.ts --><!-- Source: src/ui/sidebar/commands/cmd-dismiss-migration-notice.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_READ_METRICS` | required `{ includeArchives?: boolean, runIds?: string[0..64] }` | P | <!-- Source: src/contracts/sidebar-ipc/metrics.ts --><!-- Source: src/ui/sidebar/commands/primacy-gate.ts --> |
| `CMD_PING_BACKEND` | `{ runner: 'claude' or 'codex' or 'agy' }` | R | <!-- Source: src/contracts/sidebar-ipc.ts --> |
| `CMD_EXPORT_PROCESS_YAML` | export-selection union below; may write the operator-selected file but changes no extension state | R | <!-- Source: src/contracts/sidebar-ipc/process-yaml.ts --><!-- Source: src/ui/sidebar/commands/cmd-export-process-yaml.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_PREFLIGHT_PROCESS_YAML` | required `{}` | R | <!-- Source: src/contracts/sidebar-ipc/process-yaml.ts --> |
| `CMD_LAUNCH_PIPELINE` | `{ request: RunRequest, queueId?: string }` | M | <!-- Source: src/contracts/sidebar-ipc/run-launcher.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_LAUNCH_WORKFLOW` | `{ workflowId: string, startNodeId: string, request: RunRequest, queueId?: string }` | M | <!-- Source: src/contracts/sidebar-ipc/workflow-run.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_CONTINUE_WORKFLOW` | `{ connectedRunId: string, expectedRevision: non-negative integer, nodeId: string, request: RunRequest }` | M | <!-- Source: src/contracts/sidebar-ipc/workflow-run.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |

### Shared payload structures

`kind` in catalog lifecycle requests is exactly `'phase'`, `'pipeline'`, or `'workflow'`. `expectedDraftVersion` is a catalog version ID or the literal `no-draft`. Package requests carry those same three kinds; the service drops empty layers and enforces dependency order—Phase, then Pipeline, then Workflow—regardless of incoming order.

<!-- Source: src/contracts/catalog-store.ts -->
<!-- Source: src/contracts/catalog-lifecycle.ts -->
<!-- Source: src/catalog/package-publish.ts -->

`startIntent` has two legal forms:

- Enqueue: `{ startMode: 'now' | 'scheduled', scheduledStartAt?: positive finite epoch milliseconds, source }`. `scheduledStartAt` is required only for `scheduled`. Accepted sources are `operator-chooser`, `operator-restart`, `programmatic-now`, `programmatic-scheduled`, and `migration-default`; the declared host-internal `system-rate-limit-recovery` source is rejected at IPC ingress.
- Start queue: `{ startMode: 'now' | 'scheduled' | 'cancel-schedule', scheduledStartAt?, source: 'operator-restart' }`, with the same scheduled-time rule.

<!-- Source: src/contracts/start-intent-types.ts -->

`RunRequest` is exactly:

```ts
{
  pipelineId: string;
  inputs: { portId: string; type: PipelineInputPortType; value: string }[];
  supplemental: (
    | { kind: 'local-file'; path: string }
    | { kind: 'local-folder'; path: string }
    | { kind: 'url'; url: string }
    | { kind: 'text'; text: string }
    | { kind: 'instruction'; text: string }
    | { kind: 'prior-output'; reference: { sourceRunId: string; outputName: string } }
  )[];
  outputs: {
    portId: string;
    target: string;
    overwriteConfirmed?: boolean;
    externalSideEffectConfirmed?: boolean;
  }[];
  instructions?: string;
}
```

`PipelineInputPortType` is one of `text`, `source`, `source-list`, `local-file`, `local-folder`, `web-url`, `pipeline-output`, or `repository-context`. Local paths and output targets crossing IPC are workspace-relative; absolute resolution remains host-side.

<!-- Source: src/contracts/run-request.ts -->
<!-- Source: src/contracts/pipeline-definitions.ts -->
<!-- Source: src/contracts/sidebar-ipc/run-launcher.ts -->

`CMD_EXPORT_PROCESS_YAML` accepts exactly one of:

- `{ resourceKind: 'phase', resourceId }`
- `{ resourceKind: 'pipeline', resourceId, inclusion: 'references-only' | 'include-referenced' }`
- `{ resourceKind: 'workflow', resourceId, inclusion: 'references-only' | 'include-pipelines' | 'include-closure' }`
- `{ resourceKind: 'modelCatalog' }`

The webview supplies no file path for export or preflight; the host owns the open/save dialogs.

<!-- Source: src/contracts/sidebar-ipc/process-yaml.ts -->

`CMD_SAVE_GENERAL_SETTINGS.updates` accepts only these unprefixed keys, and validates the entire batch before writing: `cli.path`, `codex.path`, `agy.path`, `logging.verbose`, `loop.maxIterations`, `invocation.idleTimeoutSeconds`, `invocation.maxDurationSeconds`, `watchdog.pollIntervalMinutes`, `audit.rotation.sizeMB`, `audit.rotation.maxAgeDays`, `defaultPipelineId`, `fatalSignatures`, `claude.autoCompactPctOverride`, `queue.globalConcurrencyCap`, `queue.defaultQueueId`, `logging.runtimeLogLevel`, `logging.runtimeLogFilePath`, `retry.maxAttempts`, `retry.forceContinueOnCap`, `logging.runtimeLogMaxBytes`, `logging.runtimeLogMaxGenerations`, `logging.sessionRetentionMaxAgeDays`, `logging.sessionRetentionMaxBytes`, and `logging.rawTranscriptMode`.

<!-- Source: src/config/general-settings.ts -->

`CMD_SET_CONFIRM_SUPPRESSION.actionKey` is handler-validated against exactly: `queue.clean-all`, `queue.clear-done`, `queue.remove-item`, `queue.cancel-item`, `queue.pause`, `queue.resume`, `run.retry-phase-now`, `run.restart-canceled`, `run.modify-task`, `history.rerun`, and `workspace.reset`. The webview `ActionKey` union currently declares five additional keys—`run.skip-phase`, `catalog.deactivate-definition`, `catalog.discard-draft`, `run.overwrite-output`, and `queue.delete`—that this host handler rejects as `unknown-action-key`.

<!-- Source: webview-ui/src/lib/action-copy.ts -->
<!-- Source: src/state/confirm-suppression.ts -->
<!-- Source: src/ui/sidebar/commands/cmd-set-confirm-suppression.ts -->

### Known boundary mismatches

- The TypeScript `ResumeCommand` permits an optional `{ prompt? }`, but runtime validation rejects every `CMD_RESUME` payload. The shipped ingress therefore accepts no payload.
- The TypeScript `ResumeQueueCommand` permits `{ queueId?, prompt? }`, but runtime validation accepts only `queueId`; `prompt` is rejected as unexpected. Both `CMD_PAUSE_QUEUE` and `CMD_RESUME_QUEUE` also accept an array such as `[]` as a payload and normalize it to no payload because their validators check for an object but not for an array.
- `CMD_SAVE_MODELS` requires a valid `models` map, but ignores unexpected payload keys, silently omits malformed optional `expectedRevision` or `mutation` fields, and does not enforce coupling between revision and mutation metadata.
- The declared enqueue `startIntent.source` union includes `system-rate-limit-recovery`, but `CMD_START` ingress deliberately rejects that host-internal source.
- The `ReadPhaseLogCommand` TypeScript interface requires `selection.iterationN`; runtime ingress accepts omission and normalizes it to `null`.
- `CMD_SET_CONFIRM_SUPPRESSION` ingress strips unexpected payload keys rather than rejecting them. Its physical host allowlist has also drifted behind the webview union as documented above, despite comments claiming the two sets are mirrored.
- `CMD_READ_METRICS` requires a payload object and rejects unexpected object fields, but also accepts an array such as `[]` and normalizes it to `{}`. Its discriminator guard has the opposite partial behavior: it rejects arrays but admits unexpected object keys. Production hosts use ingress validation, not this guard.
- `CMD_DISMISS_MIGRATION_NOTICE` is intentionally absent from mutation metadata even though its handler can persist `migrationNotice: 'dismissed'`; it therefore receives neither workspace-trust nor primacy protection. `CMD_EXPORT_PROCESS_YAML` is likewise classified as non-mutating because the file write is operator-selected and does not change extension state.

<!-- Source: src/contracts/sidebar-ipc.ts -->
<!-- Source: src/contracts/runtime-validators.ts -->
<!-- Source: src/contracts/validators/phase-log.ts -->
<!-- Source: src/contracts/validators/metrics.ts -->
<!-- Source: src/contracts/validators/queue.ts -->
<!-- Source: src/state/confirm-suppression.ts -->
<!-- Source: webview-ui/src/lib/action-copy.ts -->
<!-- Source: src/contracts/sidebar-command-metadata.ts -->
<!-- Source: src/ui/sidebar/commands/cmd-dismiss-migration-notice.ts -->
<!-- Source: src/ui/sidebar/commands/cmd-export-process-yaml.ts -->

## Host-to-webview messages

There are exactly three outbound message literals:

| Message | Shape | Source |
|---|---|---|
| `STATE_SNAPSHOT` | `{ type, payload: SidebarSnapshot }` | <!-- Source: src/contracts/sidebar-ipc/host-messages.ts --> |
| `CMD_ACK` | `{ type, correlationId, status: 'accepted' or 'rejected', reason?, result? }` | <!-- Source: src/contracts/sidebar-ipc/host-messages.ts --> |
| `MSG_PHASE_LOG_ENTRY` | `{ type, payload: { tailSessionId, entrySeq, entry } }`; the bounded entry carries `seq`, a closed `kind`, nullable timestamp, sanitized body, and truncation metadata. | <!-- Source: src/contracts/sidebar-ipc/host-messages.ts --> |

## Backend CLI invocations

These are child-process adapters used by Schegent; they are not Schegent commands for operators to invoke.

| Backend | Exact argv construction | Process contract | Source |
|---|---|---|---|
| Claude | `--dangerously-skip-permissions [--resume <id> | -c] -p [--model <model>] [--effort <effort>] --output-format stream-json --verbose [--debug-file <path>]` | Prompt on stdin; `cwd` is the workspace; `shell: false`; sanitized environment policy; idle timeout and cancellation; SIGTERM then SIGKILL after 2 seconds. | <!-- Source: src/runner/claude-cli.ts --> |
| Codex | `exec --json --sandbox workspace-write [--model <model>] [--config model_reasoning_effort=<effort>]` | Prompt on stdin with the same `cwd`, shell, environment, idle-timeout, cancellation, and termination contract. | <!-- Source: src/runner/codex-cli.ts --><!-- Source: src/runner/process-lifecycle-runner.ts --> |
| Agy | `--dangerously-skip-permissions [--conversation <id>] --input-format stream-json [--model <model>] [--effort <effort>] --output-format stream-json` | Prompt on stdin with the shared lifecycle, as one NDJSON `{"event":"user","message":{"content":...}}` line -- agy reads stdin only under `--input-format stream-json`. Effort `xhigh` or `max` is rejected before spawn. | <!-- Source: src/runner/agy-cli.ts --><!-- Source: src/runner/process-lifecycle-runner.ts --> |

For Claude, `--resume <id>` is used when continuation or session reuse is requested and a string session ID exists; otherwise only `isContinue: true` falls back to `-c`. Agy similarly uses `--conversation <id>` only when continuation/reuse and an ID are both present, with no flag fallback. Codex ignores the continuation/session fields. The effective permission posture recorded by the Phase runner is `unrestricted` for Claude and Agy and `workspace-write` for Codex. A Phase declaring `sideEffects: git` is refused on Codex because its sandbox keeps `.git` read-only.

<!-- Source: src/runner/claude-cli.ts -->
<!-- Source: src/runner/codex-cli.ts -->
<!-- Source: src/runner/agy-cli.ts -->
<!-- Source: src/controller/phase-runner.ts -->
<!-- Source: src/config/phase-runner-policy.ts -->

Availability probes invoke the configured executable with `--help`; Agy model discovery additionally invokes `models`. A probe uses the canonical workspace root, `shell: false`, hidden Windows process mode, a normalized 1–30-second timeout defaulting to 5, and the configured environment policy with `SCHEGENT_PHASE=runner-probe` and `SCHEGENT_ITERATION=0`. CLI paths are re-read dynamically from settings.

<!-- Source: src/services/backend-capability-service.ts -->
<!-- Source: src/config/cli-path-accessor.ts -->
<!-- Source: src/activation/backend-wiring.ts -->

Two internal calls also pass through the selected adapter:

- Cross-Phase Claude session compaction sends `Compact the conversation context. Reply with a single word: OK`, uses a 60-second timeout, forces `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=1`, resumes the prior session, and pins model `claude-haiku-4-6`.
- The credit watchdog sends `/status` with a fixed 60-second timeout through the globally selected runner. Its request supplies no environment policy fields, so `buildSpawnEnv` inherits the full extension-host environment. This differs from normal Phase/probe calls using `allowlist` or `minimal`. It has no per-call abort signal, although extension teardown still cancels all children in the runner registry.

<!-- Source: src/controller/session-compactor.ts -->
<!-- Source: src/watchdog/credit-watchdog.ts -->
<!-- Source: src/runner/spawn-env.ts -->
<!-- Source: src/runner/backend-runner-registry.ts -->
<!-- Source: src/extension.ts -->

## Source-only headless adapters

The repository contains in-process adapters for parity tests and non-editor callers: `validateProcessDefinition`, `previewProcessDocument`, `importProcessDocument`, `exportProcessDefinitions`, `launchPipelineRun`, and `continueWorkflowRun`. They accept typed JavaScript values and dependency ports; they are not HTTP endpoints, are not listed in `package.json.exports`, are not separate build entries, and TypeScript source is excluded from the VSIX. Consequently they are not a supported installed-extension API.

<!-- Source: src/headless/process-definition-api.ts -->
<!-- Source: src/headless/process-yaml-api.ts -->
<!-- Source: src/headless/pipeline-run-api.ts -->
<!-- Source: src/headless/workflow-run-api.ts -->
<!-- Source: package.json -->
<!-- Source: esbuild.config.mjs -->
<!-- Source: .vscodeignore -->

## Activation and views

The extension activates when a workspace contains `.specify/` or `.schegent/`. It contributes the `schegent` Activity Bar container and `schegent.sidebar` webview. Stage 1 always registers the sidebar placeholder and `schegent.reset`; the other 29 commands require successful workspace-bound Stage 2 initialization. All 30 go through `registerGuardedCommand`, which registers the 7 read-only IDs unwrapped and wraps each of the 23 mutating ones in a trust re-read that runs on every invocation. The separately opened singleton Dashboard panel uses view type `schegent.dashboard` and routes to Queues, Runs, History, Metrics, System Log, Builder, and Settings. No menus, keybindings, or command enablement clauses are contributed — which is why the trust boundary is in the registration helper and not in the manifest.

<!-- Source: package.json -->
<!-- Source: src/ui/dashboard/dashboard-panel.ts -->
<!-- Source: webview-ui/src/dashboard/routes.ts -->
<!-- Source: src/extension.ts -->
