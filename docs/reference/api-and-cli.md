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

- **Direct VS Code commands** have the individual guards documented below, and one gate above all of them: every one of the 38 registrations goes through `registerGuardedCommand`, which classifies the ID from `src/contracts/entry-point-dispositions.ts`. The 32 `mutating` IDs are wrapped in a re-read of `vscode.workspace.isTrusted` that runs on **every invocation** — not a boolean captured at registration, because a command outlives its registration and can be invoked after trust is granted — and a refusal warns the operator, logs once at info, and returns `undefined` rather than throwing. The 6 `read-only` IDs are registered unwrapped, so reads pay nothing. An ID in neither map does not type-check at the call site and throws at registration if cast. Until FR-R3-136 (2026-08-28) this line read "none of the 27 registrations checks `vscode.workspace.isTrusted` directly", and it was accurate: the sidebar router was the only gate, so the palette, a task, and any other installed extension reached every mutation.
- **M — mutation gate:** all 53 metadata-classified webview mutations are rejected unless `vscode.workspace.isTrusted === true` and this window holds authoritative workspace primacy. Trust is checked first. Missing callbacks, thrown checks, and any non-`true` result fail closed. A command is gated when it can start a process, write persisted state, write a file or append an audit row, whatever its name suggests; `COMMAND_AUTHORITY` in `src/contracts/sidebar-command-metadata.ts` declares an authority for every command, and a command with no entry fails `tsc`. Most gated commands are serialized, so accepted mutations run one at a time. Ping, export, preflight, the phase-log commands and the metrics read are gated without being serialized: Ping, export and preflight wait on a child process or an operator's dialog, and the others are short reads with no state the chain protects, so none of them holds a queue write behind it. [What a refused command shows](#what-a-refused-command-shows) says what an operator sees, and [Repeat protection](#repeat-protection) says what a repeated correlation ID does.
- **C — catalog content gate:** some catalog lifecycle handlers additionally require the `phases` capability for Phase authoring and the `retryConditions` capability when a newly supplied Phase body declares that field. These checks occur after the M gate and stale-draft check.
- **R — read-only:** a command whose declaration says it starts no process, writes no persisted state or file and appends no audit row. No trust or primacy check after transport validation, so it stays available in an untrusted workspace and in a secondary window.

Every webview command must be an object with a known `type`, a non-empty `correlationId` of at most 64 characters, and the command-specific payload below. The production ingress is `validateInboundMessage`; the discriminator-only `COMMAND_GUARDS` registry has no production reader; only tests read it. Each command has a runtime validator; exceptions to strict object and unexpected-field rejection are recorded under the table. Invalid messages are logged and dropped by both webview hosts without a `CMD_ACK`.

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

These 27 commands appear in the Command Palette. A question mark means that the field or whole argument is optional.

| Command and title | Accepted argument | Behavior and guard | Source |
|---|---|---|---|
| `schegent.auto` — Schegent: Run Autonomous Workflow | `{ description?, featureDir?, pipelineId?, queueId?, position?, startIntent?, callerKind?, callerId? }?` | Prompts for a missing description, defaults `queueId` to `default`, `startIntent` to immediate operator start, and `callerKind` to `human`. Run admission validates input and refuses a fresh foreign lock or paused queue. Classified `mutating` in `entry-point-dispositions.ts`, so an untrusted workspace refuses it at the point of effect; no direct primacy check. | <!-- Source: package.json --><!-- Source: src/commands/auto.ts --><!-- Source: src/commands/enqueue.ts --> |
| `schegent.schedule` — Schegent: Enqueue Feature Request | `{ description?, pipelineId?, queueId?, position?, scheduledStartAt? }?` | With no `pipelineId`, opens no picker and enqueues nothing: reveals the Schegent view and shows fixed guidance naming a Queue's **Add work** composer. With one, prompts for a missing description. Missing `scheduledStartAt` becomes `Date.now()`. Run admission refuses invalid input, a fresh foreign lock, a paused queue, or a target over the seven-day horizon. | <!-- Source: package.json --><!-- Source: src/commands/schedule.ts --><!-- Source: src/services/guarded-run-service.ts --> |
| `schegent.resume` — Schegent: Resume Paused or Failed Workflow | `prompt?: string` | Calls `tryAcquire`; then resumes only the sole paused/failed Run. Multiple candidates are refused. | <!-- Source: package.json --><!-- Source: src/activation/ui-wiring.ts --><!-- Source: src/commands/resume.ts --> |
| `schegent.cancel` — Schegent: Cancel In-Flight Workflow | `{ taskId?: string }?` | With an ID, cancels that Task. Without one, cancels only the sole running Run. Classified `mutating` in `entry-point-dispositions.ts`, so an untrusted workspace refuses it at the point of effect; no direct primacy check. **Owner-only:** after the trust check, a window that does not hold the workspace lock refuses it with the palette warning "Schegent: another window holds the workspace lock; ignoring request." and nothing runs, so no Run starts and nothing is recorded there. | <!-- Source: package.json --><!-- Source: src/commands/cancel.ts --><!-- Source: src/activation/ui-wiring.ts --> |
| `schegent.reset` — Schegent: Reset Workspace State | none | Shows the host confirmation dialog, then runs the staged workspace reset. Classified `mutating` in `entry-point-dispositions.ts`, so an untrusted workspace refuses it at the point of effect; no direct primacy check. Registered in Stage 1, before any workspace-bound service exists, so the guard imports only the pure decision and the frozen disposition map. The sidebar variant has the M gate and a prior webview confirmation. **Owner-only:** after the trust check, a window that does not hold the workspace lock refuses it with the palette warning "Schegent: another window holds the workspace lock; ignoring request." and nothing runs, so no Run starts and nothing is recorded there. | <!-- Source: package.json --><!-- Source: src/extension.ts --><!-- Source: src/commands/reset.ts --> |
| `schegent.showAuditLog` — Schegent: Show Audit Log | none | Opens `.schegent/audit.log`; reports that no log exists on read failure. Classified `read-only`, so it is registered unwrapped and stays available in an untrusted workspace. No primacy check. | <!-- Source: package.json --><!-- Source: src/commands/show-audit.ts --> |
| `schegent.reportFailedRowExits` — Schegent: Report Failed-Row Exits | none | Counts how each failed row was resolved, from the audit chain and the queue state at one cutoff, and opens an unsaved Markdown report that states what it could not see. Writes nothing and takes no lease. Classified `read-only`, so it is registered unwrapped and stays available in an untrusted workspace. No primacy check. | <!-- Source: package.json --><!-- Source: src/commands/report-failed-row-exits.ts --> |
| `schegent.exportAuditLog` — Schegent: Export Metadata-Only Audit | none | Opens a save dialog, starting in your home directory, and exports schema-v3 metadata/count fields only, to a local file written `0600`. Refuses a destination that is not a local file or that resolves into `.schegent/`. Records one `evidence-exported` audit row (a count of rows written and skipped, never a path). Classified `mutating` and owner-only (FR-R4-F04): refused in an untrusted workspace and in a window that does not own the workspace, before the dialog opens. | <!-- Source: package.json --><!-- Source: src/commands/export-audit.ts --> |
| `schegent.createDiagnosticsBundle` — Schegent: Create Diagnostics Bundle | none | Builds one JSON file for one Run you pick, for sending to someone who is helping you: the Run's status, its failure records, its metadata-only audit rows, the runtime-log lines that name it, and the host version and settings with secrets removed, at most 10 MiB with each item cut from its oldest end. Shows every included and omitted item before anything is written. The raw transcript, the transport and the verbose diagnostic tree hold your prompts, source and model output, so they are omitted unless you choose "Include raw conversation…" after a warning; the choice is per bundle and never remembered. Opens a save dialog starting in your home directory and writes the file `0600`; refuses a destination that is not a local file or that resolves into `.schegent/`. Records one `evidence-exported` audit row of kind `diagnostics-bundle` (counts only, never a path). Dismissing the Run pick, the preview, the warning or the save dialog writes no file and no row. Classified `mutating` and owner-only (FR-R4-F04): refused in an untrusted workspace and in a window that does not own the workspace. | <!-- Source: package.json --><!-- Source: src/commands/create-diagnostics-bundle.ts --> |
| `schegent.gitApprovals` — Schegent: Git Approvals | none | Lists the durable Git plan approvals stored for this workspace — definition ID (host field `pipelineId`), Git-capable phases, mutation-plan fingerprint, and when each was granted — and withdraws the one picked, or all of them, behind a modal confirmation. This is the observe-and-revoke surface FR-012 requires; the record lives in VS Code workspace state, which is not a file an operator can read or edit. Picking a row selects; only the modal's affirmative action withdraws. Classified `mutating` in `entry-point-dispositions.ts`, so an untrusted workspace refuses it at the point of effect; no primacy check. | <!-- Source: package.json --><!-- Source: src/commands/git-approvals.ts --><!-- Source: src/state/git-plan-grants.ts --> |
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
| `schegent.verifyAuditChain` — Schegent: Verify Audit Chain | none | Walks `.schegent/audit.log`'s per-entry digest chain and names the first break, then checks the history against the head checkpoint kept outside the workspace and reports one of seven loss states. Detection, not prevention: the chain head sits on the same disk as the log, and the checkpoint is a file the same OS user can edit. Classified `read-only`, so it is registered unwrapped and stays available in an untrusted workspace. No primacy check. **Omitted from this table until FR-R3-127**, which is why `tests/lint/documented-commands-exist.test.ts` now holds this page in both directions. | <!-- Source: package.json --><!-- Source: src/commands/verify-audit-chain.ts --> |
| `schegent.resetAuditCheckpoint` — Schegent: Reset Audit History Checkpoint | none | Retires the audit head checkpoint kept outside the workspace, after a modal confirmation, so the next recorded event starts a new history that begins with a reset record. Classified `mutating` and owner-only. Refuses while any `audit.log*` file is present under `.schegent/`, and deletes and moves nothing: the operator moves the history out first. Registered through `registerGuardedCommand`, so it is refused untrusted and in a window that does not own the workspace. | <!-- Source: package.json --><!-- Source: src/commands/reset-audit-checkpoint.ts --> |
| `schegent.exportRunEvidence` — Schegent: Export Run Evidence | `runId?: string` | Prompts for the Run id when none is passed, then for a destination folder, and refuses a destination inside `.schegent/`. Writes an archive plus a manifest of what it contains and what it omits. The folder dialog starts in your home directory, a destination that is not a local file or that resolves into `.schegent/` is refused, and every output is written `0600`. The manifest states that the audit history in it is shared across Runs. Records one `evidence-exported` audit row (counts, never a path). Classified `mutating` and owner-only (FR-R4-F04): refused in an untrusted workspace and in a window that does not own the workspace, before any dialog opens. | <!-- Source: package.json --><!-- Source: src/commands/evidence-commands.ts --><!-- Source: src/services/evidence-export.ts --> |
| `schegent.resetOperatorPseudonym` — Schegent: Reset Operator Pseudonym | none | Replaces the per-workspace pseudonym that audit rows carry in place of the OS account name, after a modal confirmation. Records one `operator-pseudonym-reset` row with an empty payload (neither value is in it) before the new pseudonym is stored, and changes nothing if that row cannot be written; if the row is written and the new pseudonym then cannot be stored, the old one stands and the notice says the reset was recorded but not stored. Rows already written keep the old pseudonym. Classified `mutating` and owner-only: refused in an untrusted workspace and in a window that does not own the workspace. | <!-- Source: package.json --><!-- Source: src/commands/reset-operator-pseudonym.ts --> |
| `schegent.deleteRunEvidence` — Schegent: Delete Run Evidence | `runId?: string` | Prompts for the Run id when none is passed, then confirms modally. Refuses rather than racing a live writer, and reports what it removed **and** what it could not. Audited as `evidence-deleted`. Classified `mutating` in `entry-point-dispositions.ts`, so an untrusted workspace refuses it at the point of effect; no direct primacy check. **Owner-only:** after the trust check, a window that does not hold the workspace lock refuses it with the palette warning "Schegent: another window holds the workspace lock; ignoring request." and nothing runs, so no Run starts and nothing is recorded there. | <!-- Source: package.json --><!-- Source: src/commands/evidence-commands.ts --><!-- Source: src/services/evidence-delete.ts --> |

<!-- Source: package.json -->
<!-- Source: src/activation/ui-wiring.ts -->

## Registered-only VS Code commands

These 11 IDs can be invoked through `vscode.commands.executeCommand`, but they are not contributed to the Command Palette. Palette absence is not authorization: `executeCommand` reaches a registered command from a task, from another installed extension, and from this extension's own webview alike. That is why the trust check on each row below sits at the point of effect rather than at contribution, and why the guard is code rather than an `enablement` clause.

| Command | Accepted argument | Behavior and guard | Source |
|---|---|---|---|
| `schegent.enqueue` | `{ queueId: string, description?, featureDir?, pipelineId?, position?, startIntent?, callerKind?, callerId? }` | Pure enqueue followed by drain of the named queue. Blank/absent queue IDs are refused. Run admission checks validation, a fresh foreign lock, pause state, and schedule horizon. Classified `mutating` in `entry-point-dispositions.ts`, so an untrusted workspace refuses it at the point of effect; no direct primacy check. | <!-- Source: src/activation/ui-wiring.ts --><!-- Source: src/commands/enqueue.ts --><!-- Source: src/services/guarded-run-service.ts --> |
| `schegent.startQueue` | `{ queueId?, startIntent?: { startMode: 'now' or 'scheduled' or 'cancel-schedule', scheduledStartAt?, source: 'operator-restart' } }?` | Applies an optional start/schedule intent or directly drains the named/default queue. Classified `mutating`, so an untrusted workspace refuses it at the point of effect; no direct primacy check. **Owner-only:** after the trust check, a window that does not hold the workspace lock refuses it with the palette warning "Schegent: another window holds the workspace lock; ignoring request." and nothing runs, so no Run starts and nothing is recorded there. | <!-- Source: src/activation/ui-wiring.ts --><!-- Source: src/commands/start-queue.ts --><!-- Source: src/services/guarded-run-service.ts --> |
| `schegent.restartCanceledTask` | `{ taskId?: string }?` | Requires a non-empty Task ID and `canceled` state. Classified `mutating`, so an untrusted workspace refuses it at the point of effect; no direct primacy check. **Owner-only:** after the trust check, a window that does not hold the workspace lock refuses it with the palette warning "Schegent: another window holds the workspace lock; ignoring request." and nothing runs, so no Run starts and nothing is recorded there. | <!-- Source: src/activation/ui-wiring.ts --><!-- Source: src/commands/restart-canceled-task.ts --> |
| `schegent.clearAll` | none | Requires primacy, cancels active work with a bounded acknowledgement wait, clears all queues atomically, and clears watchdog backoff. Each queue is left empty and idle: its lifecycle settles at `active-empty` and any armed scheduled start is disarmed and cleared in the same write that empties it (FR-009a). This is the one workspace-wide reset (FR-009); Queue Detail no longer routes through it (FR-R3-150). | <!-- Source: src/activation/ui-wiring.ts --><!-- Source: src/commands/clear-all.ts --> |
| `schegent.clearQueue` | `queueId: string` | Requires primacy; cancels the addressed queue's active run with a bounded acknowledgement wait, resets that queue's tasks/run/pause/scheduled-start atomically, and releases its execution lease directly. Called only from `CMD_CLEAR_QUEUE`'s sidebar handler. | <!-- Source: src/activation/ui-wiring.ts --><!-- Source: src/commands/clear-queue.ts --> |
| `schegent.retryPhaseNow` | `queueId?: string` | Requires primacy; a missing/non-string ID asks the controller to resolve a sole Run. | <!-- Source: src/activation/ui-wiring.ts --><!-- Source: src/commands/retry-phase-now.ts --> |
| `schegent.pausePhase` | `queueId?: string` | Pauses the addressed active Phase; omission is allowed only when the controller can resolve one Run. Classified `mutating`, so an untrusted workspace refuses it at the point of effect; no direct primacy check. **Owner-only:** after the trust check, a window that does not hold the workspace lock refuses it with the palette warning "Schegent: another window holds the workspace lock; ignoring request." and nothing runs, so no Run starts and nothing is recorded there. | <!-- Source: src/activation/ui-wiring.ts --> |
| `schegent.resumePhase` | `prompt?: string, queueId?: string` | Resumes the addressed active Phase; omission relies on sole-Run resolution. Classified `mutating`, so an untrusted workspace refuses it at the point of effect; no direct primacy check. **Owner-only:** after the trust check, a window that does not hold the workspace lock refuses it with the palette warning "Schegent: another window holds the workspace lock; ignoring request." and nothing runs, so no Run starts and nothing is recorded there. | <!-- Source: src/activation/ui-wiring.ts --> |
| `schegent.restartPhase` | `queueId?: string` | Restarts the addressed active Phase; omission relies on sole-Run resolution. Classified `mutating`, so an untrusted workspace refuses it at the point of effect; no direct primacy check. **Owner-only:** after the trust check, a window that does not hold the workspace lock refuses it with the palette warning "Schegent: another window holds the workspace lock; ignoring request." and nothing runs, so no Run starts and nothing is recorded there. | <!-- Source: src/activation/ui-wiring.ts --> |
| `schegent.setQueueFailurePolicy` | `(queueId: string, policy: 'halt-on-failure' or 'continue' or null)`, two positional arguments | Sets the addressed queue's stated failure policy, or removes it with `null` so the queue follows the workspace default. Refuses an unknown queue as `unknown-queue-id` and reports an unchanged policy as a no-op (`failure-policy-unchanged`). Classified `mutating`, so an untrusted workspace refuses it at the point of effect; no direct primacy check. Called only from `CMD_SET_QUEUE_FAILURE_POLICY`'s sidebar handler. | <!-- Source: src/activation/queue-failure-policy-wiring.ts --><!-- Source: src/commands/set-queue-failure-policy.ts --><!-- Source: src/contracts/entry-point-dispositions.ts --> |
| `schegent.attestTaskCompleted` | non-empty `id: string` or `{ id: string }` | Requires primacy. Records the operator's assertion that a `failed` task's work completed outside the tool, ending the halt it caused without a re-run, then asks the controller to drain the queue. Refuses `invalid-id`, `not-primary` and an illegal state. Classified `mutating`, so an untrusted workspace refuses it at the point of effect. Called only from `CMD_ATTEST_TASK_COMPLETED`'s sidebar handler, which carries the operator's `confirmed: true`. | <!-- Source: src/activation/queue-item-exit-wiring.ts --><!-- Source: src/commands/queue-ops.ts --><!-- Source: src/contracts/entry-point-dispositions.ts --> |

## Webview command boundary

The authoritative schema version is `3`. The table is exhaustive: `COMMAND_TYPES` contains exactly these 64 inbound literals, and 11 are read-only (`R`); the rest are gated (`M`). Payload notation describes the runtime boundary; `?` means optional. All rows also require the shared `type` and `correlationId` envelope.

| Inbound command | Payload | Guard | Source |
|---|---|---|---|
| `CMD_START` | `{ description: string, pipelineId?, queueId?, position?: non-negative integer, startIntent? }` | M | <!-- Source: src/contracts/sidebar-ipc.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_CANCEL` | `{ taskId: string }` | M | <!-- Source: src/contracts/sidebar-ipc.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_REMOVE_QUEUE_ITEM` | `{ id: string, confirmed: true }` | M | <!-- Source: src/contracts/sidebar-ipc.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_OPEN_AUDIT_LOG` | no payload | R | <!-- Source: src/contracts/sidebar-ipc.ts --> |
| `CMD_RETRY_QUEUE_ITEM` | `{ id: string }` | M | <!-- Source: src/contracts/sidebar-ipc.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_MOVE_QUEUE_ITEM_UP` | `{ id: string }` | M | <!-- Source: src/contracts/sidebar-ipc.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_MOVE_QUEUE_ITEM_DOWN` | `{ id: string }` | M | <!-- Source: src/contracts/sidebar-ipc.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_CLEAR_COMPLETED` | `{ queueId: string }` | M | <!-- Source: src/contracts/sidebar-ipc.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_PAUSE_QUEUE` | optional `{ queueId?, reason? }` | M | <!-- Source: src/contracts/sidebar-ipc.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_RESUME_QUEUE` | optional `{ queueId? }` at runtime | M | <!-- Source: src/contracts/sidebar-ipc.ts --><!-- Source: src/contracts/runtime-validators.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_OPEN_DASHBOARD` | no payload | R | <!-- Source: src/contracts/sidebar-ipc.ts --> |
| `CMD_RERUN_FROM_HISTORY` | `{ runId: string, force?: boolean }` | M | <!-- Source: src/contracts/sidebar-ipc.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
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
| `CMD_SET_UNCONTAINED_BACKEND_GRANT` | `{ kind: 'claude' or 'codex' or 'agy', granted: boolean }` | M | <!-- Source: src/contracts/sidebar-ipc/uncontained-grant.ts --><!-- Source: src/contracts/validators/uncontained-grant.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --><!-- Source: src/ui/sidebar/commands/cmd-set-uncontained-backend-grant.ts --> |
| `CMD_RETRY_PHASE_NOW` | `{ queueId: string }` | M | <!-- Source: src/contracts/sidebar-ipc/run-controls.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_PAUSE_PHASE` | `{ queueId: string }` | M | <!-- Source: src/contracts/sidebar-ipc/run-controls.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_RESUME_PHASE` | `{ queueId: string, prompt?: string }` | M | <!-- Source: src/contracts/sidebar-ipc/run-controls.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_RESTART_PHASE` | `{ queueId: string, phaseId: string }` | M | <!-- Source: src/contracts/sidebar-ipc/run-controls.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_SKIP_PHASE` | `{ queueId: string, runId: string, phaseId: string }` | M | <!-- Source: src/contracts/sidebar-ipc/run-controls.ts --><!-- Source: src/contracts/validators/phase-control.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_DISABLE_PHASE` | `{ queueId: string, phaseId: string }` | M | <!-- Source: src/contracts/sidebar-ipc/run-controls.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_ENABLE_PHASE` | `{ queueId: string, phaseId: string }` | M | <!-- Source: src/contracts/sidebar-ipc/run-controls.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_REMOVE_TASK_PHASE` | `{ taskId: string, phaseId: string, confirmed: true }` | M | <!-- Source: src/contracts/sidebar-ipc/run-controls.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_CREATE_QUEUE` | `{ name: string }` | M | <!-- Source: src/contracts/sidebar-ipc/queue.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_RENAME_QUEUE` | `{ queueId: string, name: string }` | M | <!-- Source: src/contracts/sidebar-ipc/queue.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_DELETE_QUEUE` | `{ queueId: string, confirmed?: true }` | M | <!-- Source: src/contracts/sidebar-ipc/queue.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_SAVE_QUEUE_SETTINGS` | `{ globalConcurrencyCap: integer 1–20, defaultQueueId: string }`. Both are workspace state, not settings keys, and this is the **only** command that writes either. | M | <!-- Source: src/contracts/sidebar-ipc/queue.ts --><!-- Source: src/contracts/validators/queue-management.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --><!-- Source: src/state/workspace-state.ts --> |
| `CMD_SET_QUEUE_FAILURE_POLICY` | `{ queueId: string, policy: 'halt-on-failure' or 'continue' or null }`; `null` removes the queue's stated policy so it follows the workspace default | M | <!-- Source: src/contracts/sidebar-ipc/queue.ts --><!-- Source: src/contracts/validators/queue-management.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --><!-- Source: src/ui/sidebar/commands/cmd-set-queue-failure-policy.ts --> |
| `CMD_ATTEST_TASK_COMPLETED` | `{ taskId: string, confirmed: true }`; the literal `true` is required on the wire, and the host resolves the task's queue itself | M | <!-- Source: src/contracts/sidebar-ipc/queue.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --><!-- Source: src/ui/sidebar/commands/cmd-attest-task-completed.ts --> |
| `CMD_MOVE_TASK` | `{ taskId: string, targetQueueId: string, position?: non-negative integer }` | M | <!-- Source: src/contracts/sidebar-ipc/queue.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_MODIFY_TASK` | `{ taskId: string, description: string }` | M | <!-- Source: src/contracts/sidebar-ipc/run-controls.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_REORDER_TASK` | `{ taskId: string, newPosition: non-negative integer }` | M | <!-- Source: src/contracts/sidebar-ipc/run-controls.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_RESTART_CANCELED_TASK` | `{ taskId: string }` | M | <!-- Source: src/contracts/sidebar-ipc/run-controls.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_READ_PHASE_LOG` | `{ selection: { queueId, taskId, pipelineId, phaseId, iterationN?: positive integer or null } }`; omission becomes `null` | M | <!-- Source: src/contracts/sidebar-ipc/phase-log.ts --><!-- Source: src/contracts/validators/phase-log.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_START_PHASE_LOG_TAIL` | `{ selection: { queueId, taskId, pipelineId, phaseId, iterationN: integer } }` | M | <!-- Source: src/contracts/sidebar-ipc/phase-log.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_STOP_PHASE_LOG_TAIL` | `{ sessionId: string }` | M | <!-- Source: src/contracts/sidebar-ipc/phase-log.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_OPEN_VERBOSE_SETTING` | no payload | R | <!-- Source: src/contracts/sidebar-ipc.ts --> |
| `CMD_OPEN_TRUST_SETTINGS` | no payload; the `schegent.trust` query is a literal in the handler, never webview-supplied | R | <!-- Source: src/contracts/sidebar-ipc.ts --><!-- Source: src/ui/sidebar/commands/cmd-open-trust-settings.ts --> |
| `CMD_RESOLVE_AUDIT_POINTER` | `{ runId: string }` | R | <!-- Source: src/contracts/sidebar-ipc/history-evidence.ts --> |
| `CMD_RESOLVE_HISTORY_DESCRIPTION` | `{ runId: string }` | R | <!-- Source: src/contracts/sidebar-ipc/history-description.ts --><!-- Source: src/contracts/validators/history-description.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_READ_FAILURE_RECORD` | `{ queueId: string, taskId: string }` | R | <!-- Source: src/contracts/sidebar-ipc/failure-record.ts --><!-- Source: src/contracts/validators/failure-record.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_OPEN_DECISION_RECORD` | `{ rowId: string }`; the row id only, no path and no text. The answer is one of nine outcomes and carries neither a path nor record text | R | <!-- Source: src/contracts/sidebar-ipc/decision-record.ts --><!-- Source: src/contracts/validators/decision-record.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_READ_STORAGE_DETAILS` | `{ cursor?: string }`; an opaque inventory cursor only. The answer is the storage pressure report and one inventory page, with opaque ids and no path | R | <!-- Source: src/contracts/sidebar-ipc/storage-details.ts --><!-- Source: src/contracts/validators/artifact-lifecycle.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_SET_PHASE_BREAKPOINT` | `{ queueId: string, runId: string, phaseId: string }` | M | <!-- Source: src/contracts/sidebar-ipc/run-controls.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_CLEAR_PHASE_BREAKPOINT` | `{ queueId: string, runId: string, phaseId: string }` | M | <!-- Source: src/contracts/sidebar-ipc/run-controls.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_START_QUEUE` | no payload, `{}`, or `{ queueId?, startIntent? }` | M | <!-- Source: src/contracts/sidebar-ipc.ts --><!-- Source: src/contracts/start-intent-types.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_CLEAR_QUEUE` | `{ queueId: string }` | M | <!-- Source: src/contracts/sidebar-ipc.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_SET_CONFIRM_SUPPRESSION` | `{ actionKey: string, suppressed: boolean }`; the handler's closed key set is below | M | <!-- Source: src/contracts/sidebar-ipc.ts --><!-- Source: src/ui/sidebar/commands/cmd-set-confirm-suppression.ts --><!-- Source: src/state/confirm-suppression.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_DISMISS_MIGRATION_NOTICE` | no payload; writes the persisted `migrationNotice: 'dismissed'` state, so it is gated and serialized | M | <!-- Source: src/contracts/sidebar-ipc.ts --><!-- Source: src/ui/sidebar/commands/cmd-dismiss-migration-notice.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_READ_METRICS` | required `{ includeArchives?: boolean, runIds?: string[0..64] }`; appends a `metrics-view-opened` row once per session, so the router gates it; the handler also keeps its own primacy check | M | <!-- Source: src/contracts/sidebar-ipc/metrics.ts --><!-- Source: src/ui/sidebar/commands/primacy-gate.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_PING_BACKEND` | `{ runner: 'claude' or 'codex' or 'agy' }` | M | <!-- Source: src/contracts/sidebar-ipc.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_EXPORT_PROCESS_YAML` | export-selection union below; writes the operator-selected file and appends an export audit row for every outcome, so it is gated, and it is not serialized | M | <!-- Source: src/contracts/sidebar-ipc/process-yaml.ts --><!-- Source: src/ui/sidebar/commands/cmd-export-process-yaml.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_PREFLIGHT_PROCESS_YAML` | required `{}` | M | <!-- Source: src/contracts/sidebar-ipc/process-yaml.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_LAUNCH_PIPELINE` | `{ request: RunRequest, queueId?: string }`; sent by the History rerun of a Pipeline Run, not by the **Add work** composer | M | <!-- Source: src/contracts/sidebar-ipc/run-launcher.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_LAUNCH_WORKFLOW` | `{ workflowId: string, startNodeId: string, request: RunRequest, queueId?: string }` | M | <!-- Source: src/contracts/sidebar-ipc/workflow-run.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --> |
| `CMD_CONTINUE_WORKFLOW` | `{ connectedRunId: string, expectedRevision: non-negative integer, nodeId: string, request: RunRequest, invocationId?, operation?, commandId?, controlCommand?: ControlCommandEnvelope v1 }` | M | <!-- Source: src/contracts/sidebar-ipc/workflow-run.ts --><!-- Source: src/contracts/sidebar-command-metadata.ts --><!-- Source: src/services/workflow-execution/control-command-service.ts --> |

### What a refused command shows

A gated command is refused for one of two reasons. In an untrusted workspace it acknowledges `untrusted-workspace`; in a trusted window that does not hold the workspace lock it acknowledges `secondary-window-readonly`. Trust is checked first, so an untrusted workspace cannot learn whether a window is primary. The host shows one warning toast ("Workspace is not trusted. Commands that modify settings are disabled", or "Another window holds the workspace lock. Commands are disabled") and logs the refusal once at warn with the command type and correlation ID, never a payload. The handler does not run, so no process starts, nothing is written and no audit row is appended. A raw IPC message is refused the same way, whatever the webview shows or disables. A read-only command has no gate and behaves the same in every window.

The webview words the two reasons as "The workspace is not trusted, so this action is unavailable." and "This window is not the primary one, so it cannot make this change." The eight commands that became gated look like this to an operator:

| Command | Webview | Host |
|---|---|---|
| Ping | Nothing changes. The Ping button's state comes from the host snapshot, which does not change, so the state stays idle and no result line appears. | The warning toast. |
| Export process YAML | No dialog opens. The export button does not wait for the acknowledgement, so no text appears beside it. | The warning toast. |
| Preflight process YAML | The import panel reports the refusal in the sentence for the reason. | The warning toast. |
| Dismiss migration notice | The notice stays, because only a snapshot that records the dismissal hides it. | The warning toast. |
| Read metrics | The metrics view shows the sentence for the reason. | The warning toast. |
| Read phase log, start or stop phase-log tail | The phase-log feed shows "Could not load logs:" followed by the sentence for the reason, because the read is refused for the same two reasons. The tail adds no message of its own: a refused start leaves the feed without live updates, and a refused stop clears the feed's own session locally. A window that loses primacy while a tail runs cannot stop it. The tail ends when it is stopped, when its task leaves in flight, when the next tail starts (one runs at a time), when the dashboard panel closes or when the extension shuts down. | The warning toast. |

<!-- Source: src/ui/sidebar/message-router.ts -->
<!-- Source: src/ui/sidebar/commands/constants.ts -->
<!-- Source: src/contracts/sidebar-command-metadata.ts -->
<!-- Source: webview-ui/src/lib/boundary-refusal-text.ts -->
<!-- Source: webview-ui/src/lib/process-yaml-ipc.ts -->
<!-- Source: webview-ui/src/lib/metrics-ipc.ts -->
<!-- Source: webview-ui/src/lib/phase-log-ipc.ts -->
<!-- Source: webview-ui/src/lib/phase-log-store.svelte.ts -->

### Repeat protection

A repeat of a command reuses its identity only while the first send is unresolved and within one hour of it. The host remembers the first outcome of each correlation ID for one hour and at most 1,000 outcomes, the oldest dropped first, and answers a repeat with that outcome without running the command again; a gated read is remembered with its result and counts toward the same bound, so heavy read traffic shortens protection for mutations. A webview that waited five seconds and has no answer reports that the outcome is not yet known, not that the action failed, because the host may still run it, and it shows the outcome once if it arrives. A host restart, a webview reload (the Dashboard reloads when it is hidden) or a different panel starts a new action, and so does either bound. This reduces the risk of a repeated action; it is not exactly-once delivery.

<!-- Source: src/contracts/ack-retention.ts -->
<!-- Source: src/ui/sidebar/mutation-command-executor.ts -->
<!-- Source: webview-ui/src/lib/intent-ledger.ts -->

### Shared payload structures

`kind` in catalog lifecycle requests is exactly `'phase'`, `'pipeline'`, or `'workflow'`; `'pipeline'` is the retired third kind (see [Current limitations](../explanation/core-concepts.md#current-limitations)). `expectedDraftVersion` is a catalog version ID or the literal `no-draft`. Package requests carry those same three kinds; the service drops empty layers and enforces dependency order—Phase, then Pipeline, then Workflow—regardless of incoming order.

<!-- Source: src/contracts/catalog-store.ts -->
<!-- Source: src/contracts/catalog-lifecycle.ts -->
<!-- Source: src/catalog/package-publish.ts -->

A Phase `body` is the authored Phase document; [Custom Phases](../features/custom-phases.md#phase-definition-reference) is its field reference. One field is named here because it is new and because both authoring routes must admit it identically: `onRetryCap` is `'fail' | 'continue' | 'continue-degraded'` — what the Phase does when its `retryCondition` is still truthy at the final allowed iteration, respectively failing, advancing with an unverified warning, or advancing and recording a durable degraded mark on the Task. Omitting it inherits `schegent.retry.forceContinueOnCap`, and an unconfigured workspace resolves to `fail`. It supersedes the boolean `forceContinueOnRetryCap`, which is deprecated and **keeps loading indefinitely** under the mapping `true` → `continue`, `false` → `fail`: no stored or exported document needs editing, now or later, and a body declaring both is resolved by `onRetryCap`. Both spellings belong to the closed authored-field set, so this command and the process-YAML import path accept exactly the same fields — a field admitted by one route and refused by the other is the defect that set exists to prevent.

<!-- Source: src/contracts/process-definitions.ts -->
<!-- Source: src/contracts/retry-cap-outcome.ts -->
<!-- Source: src/config/process-definition-validator.ts -->

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
- `{ resourceKind: 'workflow', resourceId, inclusion: 'references-only' | 'include-closure' }`
- `{ resourceKind: 'modelCatalog' }`

The webview supplies no file path for export or preflight; the host owns the open/save dialogs.

<!-- Source: src/contracts/sidebar-ipc/process-yaml.ts -->

`CMD_SAVE_GENERAL_SETTINGS.updates` accepts only these 33 unprefixed keys, and validates the entire batch before writing: `cli.path`, `codex.path`, `agy.path`, `logging.verbose`, `loop.maxIterations`, `invocation.idleTimeoutSeconds`, `invocation.maxDurationSeconds`, `watchdog.pollIntervalMinutes`, `audit.rotation.sizeMB`, `audit.rotation.maxAgeDays`, `defaultWorkflowId`, `fatalSignatures`, `claude.autoCompactPctOverride`, `logging.runtimeLogLevel`, `logging.runtimeLogFilePath`, `retry.maxAttempts`, `retry.forceContinueOnCap`, `logging.runtimeLogMaxBytes`, `logging.runtimeLogMaxGenerations`, `logging.sessionRetentionMaxAgeDays`, `logging.sessionRetentionMaxBytes`, `logging.rawTranscriptMode`, `logging.transportCaptureMode`, `cli.inheritEnvironment`, `cli.environmentMode`, `cli.environmentAllowlist`, `backend.probeTimeoutSeconds`, `ui.confirmations.enable`, `multiRoot.suppressWarning`, `backend.runner`, `spend.maxUsdPerRun`, `spend.maxTokensPerRun`, and `queue.haltOnTaskFailure`.

The last six entered `KEY_SPECS` with `FR-R3-143`. A batch naming one of them before that was rejected as `unknown-key:<key>`, because the accepted set is the key list of `KEY_SPECS` itself.

`queue.globalConcurrencyCap` and `queue.defaultQueueId` are **not** in that set. Neither is a settings key: both are workspace state, and `CMD_SAVE_QUEUE_SETTINGS` above is the only command that writes either.

<!-- Source: src/config/general-settings.ts -->
<!-- Source: src/contracts/sidebar-ipc/queue.ts -->
<!-- Source: src/state/workspace-state.ts -->

`CMD_SET_CONFIRM_SUPPRESSION.actionKey` is handler-validated against these 19 keys: `queue.clean-all`, `queue.clear-done`, `queue.remove-item`, `queue.cancel-item`, `queue.pause`, `queue.resume`, `run.retry-phase-now`, `run.restart-canceled`, `run.modify-task`, `history.rerun`, `workspace.reset`, `run.skip-phase`, `catalog.deactivate-definition`, `catalog.discard-draft`, `run.overwrite-output`, `queue.delete`, `settings.disable-confirmations`, `backend.grant-uncontained`, and `queue.attest-completed`. Any other value is rejected as `unknown-action-key`.

The host allowlist and the webview `ActionKey` union are one set rather than two lists kept in step. `src/contracts/action-keys.ts` declares the tuple; `KNOWN_ACTION_KEYS` in `src/state/confirm-suppression.ts` is a `Set` built over it; `webview-ui/src/lib/generated/action-keys.ts` is a whole-file mirror that `npm run contracts:check` regenerates and compares. Before feature 193 (`FR-R3-154`) each side declared its own copy, and this page recorded the drift that followed: eleven keys accepted by the host against sixteen offered by the webview, so five confirmation dialogs wrote a "don't ask again" the host refused. `scripts/check-docs.mjs` now derives the list above from the tuple and fails when the two disagree, which is why the count is stated here rather than left implicit.

<!-- Source: src/contracts/action-keys.ts -->
<!-- Source: webview-ui/src/lib/action-copy.ts -->
<!-- Source: src/state/confirm-suppression.ts -->
<!-- Source: src/ui/sidebar/commands/cmd-set-confirm-suppression.ts -->
<!-- Source: scripts/check-docs.mjs -->

### Known boundary mismatches

- In the Builder (`PhaseCatalogEditor` and `WorkflowCatalogEditor`), a definition's authored `version` integer is a field of the definition, read-only in the form editor and preserved on portable YAML import. It is not the catalog's version id (`v1`, `v2`, ...), which the catalog store assigns to each version record it writes (`nextVersionId`), and concurrent draft and catalog writes are arbitrated by `expectedDraftVersion` and `catalog.revision`.
- Same-panel retries of unresolved commands sent through `sendIntent` (`intent-ledger.ts`) reuse the original `correlationId` and payload within the 60-minute / 1,000-entry `ACK_RETENTION` window so `MutationCommandExecutor` replays the original outcome without re-running the effect; webview reload, opening a new panel, host restart, or retention-window expiry starts a new intent by design (risk reduction, not universal durable deduplication).
- The TypeScript `ResumeQueueCommand` permits `{ queueId?, prompt? }`, but runtime validation accepts only `queueId`; `prompt` is rejected as unexpected. Both `CMD_PAUSE_QUEUE` and `CMD_RESUME_QUEUE` also accept an array such as `[]` as a payload and normalize it to no payload because their validators check for an object but not for an array.
- `CMD_SAVE_MODELS` requires a valid `models` map, but ignores unexpected payload keys, silently omits malformed optional `expectedRevision` or `mutation` fields, and does not enforce coupling between revision and mutation metadata.
- The declared enqueue `startIntent.source` union includes `system-rate-limit-recovery`, but `CMD_START` ingress deliberately rejects that host-internal source.
- The `ReadPhaseLogCommand` TypeScript interface requires `selection.iterationN`; runtime ingress accepts omission and normalizes it to `null`.
- `CMD_SET_CONFIRM_SUPPRESSION` ingress strips unexpected payload keys rather than rejecting them. The allowlist drift this bullet also recorded is closed: feature 193 made `src/contracts/action-keys.ts` the one declaration both sides derive from, so the comments that claimed the two sets were mirrored now describe a generated artifact instead of a convention.
- `CMD_READ_METRICS` requires a payload object and rejects unexpected object fields, but also accepts an array such as `[]` and normalizes it to `{}`. Its discriminator guard has the opposite partial behavior: it rejects arrays but admits unexpected object keys. Production hosts use ingress validation, not this guard.
- `CMD_DISMISS_MIGRATION_NOTICE` and `CMD_EXPORT_PROCESS_YAML` were once classified as non-mutating, and so received neither workspace-trust nor primacy protection, although the first persists `migrationNotice: 'dismissed'` and the second writes a file. `COMMAND_AUTHORITY` declares both gated now, and every other command with an effect (Ping, preflight, the metrics read and the three phase-log commands) with them.

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
| Claude | `--dangerously-skip-permissions [--resume <id> \| -c] -p [--model <model>] [--effort <effort>] --output-format stream-json --verbose [--debug-file <path>]` | Prompt on stdin; `cwd` is the workspace; `shell: false`; sanitized environment policy; idle timeout and cancellation; SIGTERM then SIGKILL after 2 seconds. | <!-- Source: src/runner/claude-cli.ts --> |
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

Five host spawns of a configured backend CLI receive the effective environment policy and build their child environment through `buildSpawnEnv`: Phase invocations, the availability probe above, the CLI version probe (`<cli> --version`, `shell: false`, a 5-second bound, its answer cached per executable path and per policy), and the two internal calls below. A `schegent.cli.environmentMode` value that is not one of the three modes resolves to `allowlist`.

Two internal calls also pass through the selected adapter:

- Cross-Phase Claude session compaction sends `Compact the conversation context. Reply with a single word: OK`, uses a 300-second idle timeout with a 1200-second wall-clock bound, forces `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=1`, resumes the prior session, and pins model `claude-haiku-5-5`. The idle bound must stay above the monitor's 90-second stall threshold (`MONITOR_STALL_THRESHOLD_MS`; the 90-second stall threshold is a constant, not a setting): below it, a silent compaction child is terminated before the watchdog can declare it stalled, and the window is unreportable.
- The credit watchdog sends `/status` with a fixed 60-second timeout through the globally selected runner. Its request carries the same environment policy fields as every other call, through `policyRequestFields`. It has no per-call abort signal, although extension teardown still cancels all children in the runner registry.

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

The extension activates when a workspace contains `.specify/` or `.schegent/`. It contributes the `schegent` Activity Bar container and `schegent.sidebar` webview. Stage 1 always registers the sidebar placeholder and `schegent.reset`; the other 37 commands require successful workspace-bound Stage 2 initialization. All 38 go through `registerGuardedCommand`, which registers the 6 read-only IDs unwrapped and wraps each of the 32 mutating ones in a trust re-read that runs on every invocation. The separately opened singleton Dashboard panel uses view type `schegent.dashboard` and routes to Queues, History, Metrics, System Log, Builder, and Settings. No menus, keybindings, or command enablement clauses are contributed — which is why the trust boundary is in the registration helper and not in the manifest.

<!-- Source: package.json -->
<!-- Source: src/ui/dashboard/dashboard-panel.ts -->
<!-- Source: webview-ui/src/dashboard/routes.ts -->
<!-- Source: src/extension.ts -->
