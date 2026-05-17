# Schegent Webview UI

Svelte 5 + Vite 5 app that renders both the Schegent **sidebar** and the **dashboard** inside VS Code webviews. A single Vite build produces two HTML entry points; the host's renderer wires each into its own webview panel.

## Ownership

| Surface | Entry | Purpose |
|---|---|---|
| Sidebar | `webview-ui/src/App.svelte` (mounted via `index.html`) | Compact, non-scrolling **status bar** (~160px). Four zones: Status Row, Stats Strip (done/pending/failed counters + active phase line), Current Task (freshness + activity + optional CLI monitor row), and a single **Open Dashboard** button. |
| Dashboard | `webview-ui/src/dashboard/...` (mounted via `dashboard.html`) | Full-window operator console: named queue management, queue scheduling, pending-task edit/move/reorder, history rerun, monitor tail, audit drill-in, controls (cancel / resume / retry-active-run), phase tiles. All previously-sidebar capabilities live here. |

Both webviews subscribe to the same host `WorkflowSnapshot` projected by `src/ui/sidebar/state-projector.ts`. The dashboard renders the full operator surface; the sidebar projects a strict subset of the same `WorkflowSnapshot` (see `contracts/sidebar-view-contract.md` in the active spec for the testid contract).

## Layout

```
webview-ui/
├── src/
│   ├── App.svelte        — sidebar root (compact 4-zone layout)
│   ├── main.ts           — sidebar entry
│   ├── dashboard/        — dashboard entry, Dashboard.svelte, components/
│   ├── components/       — shared Svelte 5 components (StatusBar, StatsStrip,
│   │                       CurrentTask, DashboardLink, plus dashboard-only:
│   │                       PhaseTracker, ControlPanel, QueueList,
│   │                       HistorySection, ConfirmDeleteDialog, MonitorPill,
│   │                       etc. — Feature 030 removed the multi-queue
│   │                       QueueManagementPanel and QueueDeleteModal
│   │                       surfaces; the unified queue's pause/resume/clear
│   │                       affordances render inline on the Dashboard.)
│   └── lib/
│       ├── derive-stats.ts — pure helper: deriveSidebarStats / deriveActivePhase
│       ├── deletion-confirmation.ts — status-aware destructive confirmation copy
│       ├── messages.ts   — re-exports from src/contracts/webview-commands.ts
│       ├── snapshot-store.svelte.ts — latest WorkflowSnapshot + pending-correlation ids
│       ├── snapshot-types.ts — re-exports of host-projected types
│       ├── vscode-api.ts — typed postCommand / onHostMessage
│       └── theme.css     — --schegent-* tokens with --vscode-* fallback
├── index.html            — sidebar HTML shell (CSP placeholders)
└── dashboard.html        — dashboard HTML shell (CSP placeholders)
```

## IPC contract

Webview → host commands and host → webview snapshots are typed in `src/contracts/`:

- Webview → host: `WebviewCommand` (discriminated union) — see `src/contracts/webview-commands.ts`.
- Host → webview: `WebviewSnapshot` — see `src/contracts/webview-snapshots.ts`.
- Validation: `MessageRouter` validates every inbound command via `src/contracts/runtime-validators.ts`. Unknown shapes are rejected and audited as `audit.invalid_command`.

The webview's command literal types are re-exported from `src/contracts/`. There is no separate webview-side definition.

### Dynamic pipelines (spec 009)

The phase-tracking IPC shape was widened to support operator-defined pipelines:

- `PhaseName` is `string` (was a fixed literal union of the eight built-in phases). Webview components must not assume any specific phase id list.
- `PhaseTile.order` is `number` (was a 1..7 tuple). Tiles render in catalog order, with vertical scroll when the active pipeline exceeds ~10 phases.
- `PhaseTile.loopable?: boolean` is now optional, mirroring the per-phase `PhaseDef.loopable` setting.
- `WorkflowSnapshot.activePipeline?: { id: string; name: string }` is optional. When present, the dashboard header renders `Phase Progression — Pipeline: <name>`; when absent, the built-in `standard` pipeline is implied.

All four fields fall back to the prior built-in defaults when omitted, so existing snapshots continue to render unchanged.

### Sidebar outbound surface

The compact sidebar emits **only** `CMD_OPEN_DASHBOARD`. Any other operator-initiated mutation (cancel, resume, queue actions, history rerun, retry-active-run) is sent from the Dashboard webview or the VS Code Command Palette. This narrow surface is enforced by `tests/integration/sidebar-activation.host.test.ts`, which scans the sidebar bundle and asserts the four allowed `data-testid` containers (`sidebar-status-row`, `sidebar-stats-strip`, `sidebar-current-task`, `sidebar-open-dashboard-button`) plus `app-root` and rejects any reappearance of removed sidebar testids.

### Top-level routes (spec 012)

The Dashboard exposes three peer top-level routes from
`dashboard/App.svelte` (the legacy two-tier `Operations / Settings` parent
with inner tabs is gone):

| Route | Component | Purpose |
|---|---|---|
| Operations | `components/Dashboard.svelte` | Live queue, phase progression, monitor pill, history, and the collapsible **Model Catalog** section near the bottom (mounts `ModelCatalogEditor.svelte`, hidden by `<details>` until opened). |
| Pipeline Builder | `components/PipelineBuilder.svelte` | Phases editor on top (mounts `settings/PhasesTab.svelte` — the same rich editor with loopable / RetryConditionEditor / RawJsonPhaseEditor wiring), Pipelines composition area below. |
| Settings | `components/SettingsSurface.svelte` | Two sub-tabs only: **General** and **Fatal Signatures**. |

Single subscription to `snapshotStore` is in `dashboard/App.svelte`
(`$derived(snapshotStore.snapshot)`); every route receives the snapshot
as a `{snapshot}` prop.

### Settings sub-tabs (spec 012 reduction)

| Sub-tab | Component | Purpose |
|---|---|---|
| General | `components/settings/GeneralSettingsTab.svelte` | Renders every scalar `schegent.*` key from `snapshot.generalSettings` with adaptive form controls (boolean → checkbox, string → text, number → number, enum → dropdown, optional integer → number-with-clear) and a scope indicator (workspace / user / default). Save goes through the shared `lib/save-general-settings.ts` helper. |
| Fatal Signatures | `components/settings/FatalSignaturesTab.svelte` | Two sections: the read-only **Built-in registry** (rendered from the parity mirror at `lib/fatal-signature-registry.ts`) and the editable **Operator additions** list (text inputs with + Add / Remove controls). Save goes through the shared helper with the unprefixed key `fatalSignatures`. |
| Wake up | `components/settings/WakeUpTab.svelte` | Four scheduler controls, Save, a **Wake up now** action, and a latest-5 attempts log. Save goes through `lib/save-wakeup-settings.ts`; manual trigger goes through `lib/wake-up-now.ts`. Validation surfaces inline error testids (`wakeup-error-chronological-time`, `wakeup-error-periodic-interval`) and a non-blocking advisory testid (`wakeup-warning-periodic-below-5h`) when the periodic interval is < 5 h (R-07 advisory). |

Feature 030 (US3) removed the **Queue** sub-tab and its
`QueueSettingsTab.svelte` / `save-queue-settings.ts` plumbing. With
`MAX_QUEUES = 1` the per-queue concurrency cap and default-queue
selector are no longer meaningful; the global concurrency cap moved
to **General** alongside the other scalar `schegent.*` keys.

The Phases, Pipelines, and Models editors are not in `SettingsSurface` —
they live in Pipeline Builder (Phases, Pipelines) and Operations
(Models). This co-locates configuration with the workflows that consume
it.

### Settings hover-text primitive (spec 018)

Every focusable control in the four Settings sub-tabs is annotated by
the shared [`use:hoverTextAnchor`](src/components/hover-text/hover-text-anchor-action.ts)
Svelte 5 action (the primary call shape). The action picks the surface
deterministically from `description.body.length`:

- **≤ 80 chars** → renders an inline `<p id="desc-${controlId}">`
  beneath the control with a permanent `aria-describedby` link. No
  popover, no hover state.
- **> 80 chars** → wires `mouseenter` / `mouseleave` / `focus` /
  `blur` / `keydown(Escape)` listeners on the control itself and
  lazy-portals a `role="tooltip"` popover to `document.body` on
  hover/focus. The popover anchors to the control (no separate `(?)`
  trigger), opens after a 400 ms hover delay or instantly on focus,
  and respects a 100 ms mouseleave grace ("hover bridge") so the
  pointer can transit into the popover without flickering it shut.

The cutoff is enforced at action-attach time so a single description
payload can shift surface as the copy is tuned. The `<HoverText>`
component remains exported from
[`components/hover-text/HoverText.svelte`](src/components/hover-text/HoverText.svelte)
as the advanced/secondary form — most call sites should use the action.

Descriptions live in per-tab sibling modules —
`GeneralSettingsTab.descriptions.ts`,
`FatalSignaturesTab.descriptions.ts`, `WakeUpTab.descriptions.ts` —
each frozen with
`as const satisfies { readonly [K in ControlId]: ControlDescription }`
so missing or stale keys fail the webview typecheck. Descriptions are
static webview state: the IPC contract is unchanged, no new host
roundtrip, no snapshot fields added. Coverage is enforced by the
parameterized structural test at
[`components/settings/__tests__/hover-text-coverage.test.ts`](src/components/settings/__tests__/hover-text-coverage.test.ts),
which mounts each tab, walks every focusable element, and asserts both
sides of the mapping (every control has either an inline
`aria-describedby` or a `data-hover-text-anchored="true"` marker, and
no description is orphaned).

### Shared `save-general-settings.ts` helper (spec 012)

[`webview-ui/src/lib/save-general-settings.ts`](src/lib/save-general-settings.ts) is the **single call site**
for `CMD_SAVE_GENERAL_SETTINGS` in the webview (FR-031). Every component
that wants to persist a scalar `schegent.*` setting (`GeneralSettingsTab`,
`FatalSignaturesTab`, …) calls `await saveGeneralSettings(updates)`. The
helper:

1. Generates a UUIDv4 correlation id.
2. Posts the envelope through `postCommand`.
3. Awaits the matching `CMD_ACK` (5-second timeout → `{ status:
   'rejected', reason: 'timeout' }`).
4. Concurrent saves are correlated by id and never cross-resolve.

A repo-grep regression test at
[`tests/lint/no-inline-save-general-settings.test.ts`](../tests/lint/no-inline-save-general-settings.test.ts)
fails the build if any new component references `CMD_SAVE_GENERAL_SETTINGS`
directly.

### Shared `save-wakeup-settings.ts` helper (spec 014)

[`webview-ui/src/lib/save-wakeup-settings.ts`](src/lib/save-wakeup-settings.ts)
is the **single call site** for `CMD_SAVE_WAKEUP_SETTINGS` in the
webview (014, mirrors the 012 pattern). `WakeUpTab.svelte` and any
future caller MUST call `await saveWakeUpSettings(payload)` rather
than constructing the envelope inline. The helper:

1. Generates a UUIDv4 correlation id.
2. Posts the 4-key payload `{ enabled, schedulerType, chronologicalTime, periodicInterval }`.
3. Awaits the matching `CMD_ACK` (5-second timeout → `{ status: 'rejected', reason: 'timeout' }`).
4. Returns a typed reject-reason from the fixed vocabulary
   (`chronological-time-malformed`, `periodic-interval-malformed`,
   `installer-failed:<platform>:<detail>`, `secondary-window-readonly`,
   `timeout`).

A repo-grep regression test in
[`../tests/lint/`](../tests/lint/) fails the build if any new component
references `CMD_SAVE_WAKEUP_SETTINGS` directly.

### Shared `wake-up-now.ts` helper (spec 024)

[`webview-ui/src/lib/wake-up-now.ts`](src/lib/wake-up-now.ts) is the
single webview helper for `CMD_WAKE_UP_NOW`. `WakeUpTab.svelte` calls
`await wakeUpNow()` to request a primary-host-gated, one-shot wake-up
attempt without mutating saved scheduler settings. The helper uses the
standard correlation/ACK path with a 65-second timeout so the host can
return after the bounded wake-up runner completes. The latest attempts
UI reads only `snapshot.wakeUpLog`, whose rows are sanitized and capped
by the host before webview rendering.

### Feature 017 queue and phase-task IPC

Feature 017 adds dashboard-only mutating commands for phase controls
(`CMD_PAUSE_PHASE`, `CMD_RESUME_PHASE`, `CMD_RESTART_PHASE`,
`CMD_SKIP_PHASE`, `CMD_DISABLE_PHASE`, `CMD_ENABLE_PHASE`), queue
pause/resume (`CMD_PAUSE_QUEUE`, `CMD_RESUME_QUEUE`), pending tasks
(`CMD_MODIFY_TASK`, `CMD_REORDER_TASK`, `CMD_REMOVE_QUEUE_ITEM`).
Feature 030 (US3) removed the multi-queue mutators
(`CMD_CREATE_QUEUE`, `CMD_RENAME_QUEUE`, `CMD_DELETE_QUEUE`,
`CMD_MOVE_TASK`, `CMD_SAVE_QUEUE_SETTINGS`, `CMD_SET_QUEUE_SCHEDULE`,
`CMD_CLEAR_QUEUE_SCHEDULE`) along with the per-queue schedule
surface; the unified queue's pause/resume operate without a
`queueId` payload.

Feature 022 widens deletion commands:

- `CMD_REMOVE_QUEUE_ITEM` requires `{ id, confirmed: true }` and can remove
  any task status after `ConfirmDeleteDialog.svelte` confirmation.
- `CMD_REMOVE_TASK_PHASE` requires `{ taskId, phaseId, confirmed: true }` and
  removes a task-scoped phase override without changing the global pipeline.

`Dashboard.svelte` owns the new-task compose box, position selector,
and the four inline global controls (Pause / Resume / Clear Done /
Clean) for the unified queue. `QueueItemActions.svelte` owns task
edit/delete confirmation. `QueueItem.svelte` owns the up/down reorder
arrows in the sidebar list (drag-and-drop + arrows route through the
shared helper at `webview-ui/src/lib/reorder-task.ts`).
`PhaseProgression.svelte` owns phase controls, phase deletion
confirmation, and phase-message metadata rendering only, never
message values. `webview-ui/src/lib/deletion-confirmation.ts` owns
the status-aware copy for both task and phase deletion; components
should not inline destructive copy or post deletion IPC without the
shared confirmation dialog.

### IPC additions (spec 011)

Two new mutating commands ride the existing `CMD_*` discriminated union:

- `CMD_SAVE_GENERAL_SETTINGS` — payload `{ updates: Record<key, value> }`. Host validates every key against `ALLOWED_KEYS` in `src/config/general-settings.ts` and rejects transactionally. Webview pre-validates for UX but the host is the source of truth.
- `CMD_RETRY_PHASE_NOW` — payload `{ runId: string }`. Host cancels the watchdog timer, resets `delayedRetryCount`, optionally unpauses the queue (only when `pausedReason` matches `retry-cap-exhausted:<runId>`), and re-runs the phase within ~1 s.

Both commands are members of `MUTATING_COMMANDS` in `src/ui/sidebar/messages.ts`. The primary-only gate rejects mutations from secondary VS Code windows with reason `secondary-window-readonly`.

**Feature 056 Track 1 (FR-001..FR-005)** reclassified the three catalog
saves (`CMD_SAVE_PIPELINES`, `CMD_SAVE_PHASES`, `CMD_SAVE_MODELS`) and
the general-settings save (`CMD_SAVE_GENERAL_SETTINGS`) as mutating:
they all write VS Code workspace configuration and must follow the
same primary-only gate. Secondary windows now receive `status:
'rejected'`, `reason: 'secondary-window-readonly'` for every catalog
save attempt; the regression coverage lives at
[`../tests/unit/ui/sidebar/save-commands-primary-gate.test.ts`](../tests/unit/ui/sidebar/save-commands-primary-gate.test.ts).
Read-only commands (e.g. the wake-up session-log readers) stay outside
`MUTATING_COMMANDS` but still apply their own primary-host handler gate
(`reason: 'not-primary-host'`) — that path is unchanged.

### Parity-mirror pattern

Two webview modules MUST stay byte-equivalent to their host counterparts:

| Webview mirror | Host source | Parity test |
|---|---|---|
| `webview-ui/src/lib/retry-condition.ts` | `src/lib/retry-condition.ts` | `tests/parity/retry-condition-parity.test.ts` (SC-011) — broad expression fixture; webview's verdict must match host on every input. |
| `webview-ui/src/lib/fatal-signature-registry.ts` | `src/lib/fatal-signature-registry.ts` (`FATAL_SIGNATURES`) | `tests/parity/fatal-signatures-parity.test.ts` — byte-identical literal. |

Both files carry a `// Mirror of ... — Do not modify without updating both.` banner. CI fails the merge on any drift.

The webview `WorkflowSnapshot` projection includes three new 011 fields with `undefined`-safe defaults: `delayedRetryCount`, `pendingRetryAt`, `pendingRetryCause`, and the new `generalSettings: GeneralSettings` payload. Components fall back to `IDLE_GENERAL_SETTINGS` when the host omits the field (legacy-tolerance per the contract).

Feature 019 adds two scalar keys to `generalSettings`: `runtimeLogLevel: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'` (default `'INFO'`) and `runtimeLogFilePath: string` (default `''`, which the host resolves to `<workspaceRoot>/.schegent/syslog`). Both flow through the existing `CMD_SAVE_GENERAL_SETTINGS` channel via the shared `save-general-settings.ts` helper — no new IPC, no new snapshot envelope. `IDLE_GENERAL_SETTINGS` and the `scopes` map both gained matching entries (`'default'` scope for an unset value, `'workspace'` once an override is saved).

### IPC additions (spec 020)

Feature 020 introduces a **read-only** IPC surface for the Dashboard's
Phase Log Feed (Queue → Task → Phase → Iteration drill-in over
per-phase `stream.jsonl` files):

- `CMD_READ_PHASE_LOG` — payload `{ runId, queueId, pipelineId, phaseId, iteration? }`. Host validates the selection tuple against the current snapshot (queue known + task match across in-flight/pending/recent/history + phase membership in the pipeline catalog), reads the matching `stream.jsonl`, applies project → truncate (4096 UTF-8 bytes per body field) → sanitize at the IPC boundary, and returns a manifest of displayable entries plus `iterations` (most-recent-first, descending), `selectedIteration`, `skippedLines`, and `truncatedCount`.
- `CMD_START_PHASE_LOG_TAIL` — payload `{ runId, queueId, pipelineId, phaseId, iteration }`. Starts a `fs.watch` (or polling fallback) session for the selected iteration. **Cap of 1**: a new start tears down any existing session before the new one binds. Initial existing bytes are pushed, then new appends flow as they land.
- `CMD_STOP_PHASE_LOG_TAIL` — payload `{ }`. Tears down the active session.

Host → webview push channel:

- `MSG_PHASE_LOG_ENTRY` — `{ kind: 'entry' | 'tail-ended', entry?, reason? }`. Carries either a single projected/sanitized entry or a synthetic terminal `tail-ended` notice (`reason` ∈ `webview-stop` | `webview-dispose` | `phase-complete`).

All three commands are **read-only** and are NOT members of `MUTATING_COMMANDS` — they bypass the primary-only mutation gate so a secondary VS Code window can still browse logs. They flow through the shared helper at [`webview-ui/src/lib/phase-log-ipc.ts`](src/lib/phase-log-ipc.ts) (single call site); a repo-grep regression test at [`../tests/lint/no-inline-phase-log-ipc.test.ts`](../tests/lint/no-inline-phase-log-ipc.test.ts) fails the build on any drift. No new snapshot envelope keys; no `AUDIT_SCHEMA_VERSION` or `STATE_SCHEMA_VERSION` bump (logs are derived from the existing diagnostics directory).

### Pipeline Builder per-phase Effort + Model (spec 026)

[`PipelineBuilder.svelte`](src/components/PipelineBuilder.svelte) carries
per-phase **Effort** and **Model** dropdowns plus a precedence badge
("shadowed by workspace" etc.) on each row. The Pipeline Builder
(reached via the top-level Pipeline Builder route) remains the canonical
phase-editing surface; SettingsSurface intentionally does **not** carry
a Phases tab (spec 012 reduction).

The component reads `snapshot.phasePrecedence` from the host
projection (composite-key shape `"<phaseId>::<fieldKey>"`) and never
computes precedence locally. The 5 per-phase keys covered today are
`model`, `effort`, `timeoutSeconds`, `loopable`, `retryCondition`; UI
consumes `model` and `effort` and the remaining keys are reserved for
forward use without a fresh contract change.

[`webview-ui/src/lib/save-phases.ts`](src/lib/save-phases.ts) is the
**single call site** for `CMD_SAVE_PHASES` in the webview (FR-021 +
research Decision 1). Components MUST call
`await savePhases(phases)` rather than constructing the envelope
inline. The helper mirrors the shape of
[`save-general-settings.ts`](src/lib/save-general-settings.ts):

1. Generates a UUIDv4 correlation id.
2. Posts the envelope through `postCommand`.
3. Awaits the matching `CMD_ACK` (5-second timeout → typed timeout
   reject).
4. Concurrent saves are correlated by id and never cross-resolve.

A repo-grep regression test at
[`../tests/lint/no-inline-save-phases.test.ts`](../tests/lint/no-inline-save-phases.test.ts)
fails the build if any new component references `CMD_SAVE_PHASES`
directly. A user-layer save MUST be accepted even when the workspace
layer shadows the same row (FR-021) — the shadow only affects the
*effective* value used at run time, not the persisted user-layer
record.

### New built-in pipeline: `speckit-bugfix` (spec 026)

The Dashboard's new-task pipeline selector at
[`Dashboard.svelte:306-311`](src/components/Dashboard.svelte) now lists
two built-in pipelines (`speckit-new-feature`, `speckit-bugfix`). The
default selection remains `speckit-new-feature`. The shortcut form in
[`ControlPanel.svelte`](src/components/ControlPanel.svelte) does NOT
include the selector and falls back to the controller's default
pipeline (research Decision 6).

### IPC additions (spec 031 — Advanced wake-up logs & model selection)

Feature 031 adds two new **read-only** IPC commands that surface the
wake-up session log (`<globalStorageUri>/wakeup/session.log`) to the
Settings UI without exposing the file path to the webview. Both are
NOT members of `MUTATING_COMMANDS` (they do not write workspace
state); both nonetheless enforce the primary-host gate inside the
handler so a secondary VS Code window cannot ride either surface.

- `CMD_READ_WAKEUP_SESSION_LOG` — payload `{ correlationId: string }`
  (UUIDv4 re-validated at the IPC boundary). The host re-validates
  the id, locates the matching `=== wakeup-block … ===` block in
  `session.log` by id substring, single-sanitizes the projection
  (≤32 KB), and returns a typed discriminated-union response. Reject
  vocabulary: `'not-primary-host' | 'invalid-correlation-id' |
  'unknown-correlation-id' | 'session-log-unavailable' |
  'unknown-error'`.
- `CMD_REVEAL_WAKEUP_SESSION_LOG` — payload `{}` (no operator
  input). The host re-composes the path internally and dispatches
  `vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(path))`.
  Reject vocabulary: `'not-primary-host' | 'session-log-unavailable'
  | 'reveal-failed' | 'unknown-error'`.

Both commands flow through SOLE-call-site helpers — same pattern as
`save-general-settings.ts`, `save-wakeup-settings.ts`, and
`save-phases.ts`:

| Command | Helper | Lint regression |
|---|---|---|
| `CMD_READ_WAKEUP_SESSION_LOG` | [`webview-ui/src/lib/wakeup-session-log-ipc.ts`](src/lib/wakeup-session-log-ipc.ts) | [`../tests/lint/no-inline-read-wakeup-session-log.test.ts`](../tests/lint/no-inline-read-wakeup-session-log.test.ts) |
| `CMD_REVEAL_WAKEUP_SESSION_LOG` | [`webview-ui/src/lib/reveal-wakeup-session-log.ts`](src/lib/reveal-wakeup-session-log.ts) | [`../tests/lint/no-inline-reveal-wakeup-session-log.test.ts`](../tests/lint/no-inline-reveal-wakeup-session-log.test.ts) |

Both helpers use the standard `markPending + onceAck + 5 s timeout`
correlation pattern; the timeout is reified as
`{ status: 'rejected', reason: 'timeout' }` so call sites can render
a single failure state. The wake-up settings page (`WakeUpTab.svelte`)
mounts three new components from
`webview-ui/src/components/settings/wakeup/`:

- `WakeupModelSelector.svelte` — model dropdown listing
  `Default (runner-chosen)` + the three registry members
  (`claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-6`). Save
  routes through the existing `save-wakeup-settings.ts` helper —
  no new mutating IPC.
- `WakeupSessionLogPanel.svelte` — lazy expansion panel inline under
  each 031-era log row. Renders the projected body as plain
  `<pre>{text}</pre>` — never `{@html}`. Carries a "truncated"
  affordance when `bodyTruncated === true`.
- `WakeupSessionLogPathDisplay.svelte` — "Session log file:" strip
  + "Reveal in OS file manager" button. The path is read from
  `snapshot.wakeUp.sessionLogPath` (host-composed); the button
  invokes the helper above (no operator-supplied path).

Snapshot envelope additions (UI-only, additive, never persisted):

- `WorkflowSnapshot.wakeUp?: { model: WakeUpModelSelection;
  sessionLogPath: string | null }` — host-projected; `model` mirrors
  the mirror file, `sessionLogPath` is composed from
  `globalStorageUri` and surfaced for display + reveal only.
- `WakeUpLogProjectionEntry.correlationId?: string` — present on
  031-era rows that wrote a session-log block; absent on legacy
  014/024 rows and on lock-skipped rows. The UI conditionally
  renders the "Expand session" affordance on `correlationId !==
  undefined`.

`AUDIT_SCHEMA_VERSION` bumps 1 → 2 to reflect three additive scalar
fields on the `wakeup-runner-invocation` payload (`correlationId`,
`requestedModel`, `actualModel`); the audit parser is
additive-tolerant per the existing CLAUDE.md hard rule "Never drop
unknown audit event types from the parser. Warn and preserve." —
legacy readers continue to function. No `STATE_SCHEMA_VERSION` bump.

### IPC additions (spec 028 — Advanced phase pausing)

Feature 028 adds two new **mutating** IPC commands for future-phase
breakpoints:

- `CMD_SET_PHASE_BREAKPOINT` — payload `{ runId, phaseId }`. Host validates
  per Decision 10 (run in-flight, phase exists in the immutable pipeline,
  not active, not completed, no override action, not already armed),
  appends a one-shot `PhaseBreakpoint` to `WorkflowRun.phaseBreakpoints`,
  persists, and emits `phase-breakpoint-set`.
- `CMD_CLEAR_PHASE_BREAKPOINT` — payload `{ runId, phaseId }`. Filters
  the matching entry out of `WorkflowRun.phaseBreakpoints` and emits
  `phase-breakpoint-cleared { cause: 'operator' }`.

Both commands are members of `MUTATING_COMMANDS` (primary-host gated).
They flow through the shared helper at
[`webview-ui/src/lib/phase-breakpoint-ipc.ts`](src/lib/phase-breakpoint-ipc.ts)
(single call site); the repo-grep regression at
[`../tests/lint/no-inline-phase-breakpoint-ipc.test.ts`](../tests/lint/no-inline-phase-breakpoint-ipc.test.ts)
fails the build on any drift.

The existing `queue-paused` and `queue-resumed` audit events now carry
a required `source: 'operator' | 'cascade'` field so a snapshot reader
can distinguish operator-driven queue pauses from cascade-driven ones.
Three new audit event types are additive (no `AUDIT_SCHEMA_VERSION`
bump): `phase-breakpoint-set`, `phase-breakpoint-cleared`,
`phase-breakpoint-fired`. All payloads route through the existing
single-sanitization point in `audit-log-writer.ts`.

Snapshot envelope additions:

- `WorkflowSnapshot.phaseBreakpoints: readonly { phaseId: string }[]`
  — projected from `WorkflowRun.phaseBreakpoints`, sorted by `setAt`.
- `WorkflowSnapshot.resumeTargetPhaseId: string | null` — mirrors the
  run field; non-null iff `manualPauseCause === 'breakpoint-paused'`.
- `WorkflowSnapshot.activeRunId: string | null` — the in-flight run id
  (distinct from `activeTaskId`); the webview needs this to address
  the two new IPC commands.
- `QueueItemSnapshot.pauseCause` union extended with `'breakpoint'` so
  the task-level pause badge can render "Paused (breakpoint)".
- `WorkflowSnapshot.manualPauseCause` union extended with
  `'breakpoint-paused'`.

`STATE_SCHEMA_VERSION` is bumped 4 → 5 to carry `phaseBreakpoints`,
`resumeTargetPhaseId`, and `QueueRegistryEntry.pauseSource`. The
forward migrator defaults `phaseBreakpoints: []`, `resumeTargetPhaseId:
null`, and `pauseSource: 'operator'` for already-paused queues.

### Activity Feed navigation (spec 021)

The Dashboard's Activity Feed selection is local webview state. Queue rows,
task rows, phase progression steps, and the compact Activity Feed selectors
all write through the same selection tuple
`{ queueId, taskId, pipelineId, phaseId, iterationN }`, backed by
[`webview-ui/src/lib/activity-feed-selection.svelte.ts`](src/lib/activity-feed-selection.svelte.ts)
and the existing `PhaseLogStore`.

Selection is not persisted and introduces no host IPC command. Once the tuple
is complete, the existing read-only phase-log helper above performs the host
read/tail operation. Queue/task selection resolves children with an
active-then-recent cascade; "Jump to current phase" restores live-following
after manual navigation.

### Activity Feed render pipeline (spec 029 — Human-readable activity logs)

Feature 029 adds a **view-only** transformation layer that turns sanitized
`PhaseLogDisplayEntry` records into structured, human-readable UI. No new IPC,
no new audit event, no host module: everything below is webview-local and
operates on already-sanitized strings. The on-disk `stream.jsonl` is never
mutated (SC-005); the integration regression at
[`../tests/integration/phase-log-on-disk-immutability.test.ts`](../tests/integration/phase-log-on-disk-immutability.test.ts)
hashes the file before/after a manifest read + tail-session lifecycle and
asserts the SHA-256 is unchanged.

**Pure projection helpers** (TS, no DOM, no Svelte runtime):

- [`webview-ui/src/lib/activity-feed/classify-arg-value.ts`](src/lib/activity-feed/classify-arg-value.ts)
  — maps a `ToolArgumentValue` to one of `{ kind: 'scalar' | 'multiline' |
  'object' | 'array' }`. A string is classified as **multiline** when the
  key is in `LONG_FORM_KEYS = { content, code, body, text, patch, diff,
  query }` OR the value contains a newline OR is ≥200 chars. Arrays are
  capped at 50 items (overflow surfaced via `truncatedAt`); object values
  recurse one level shallowly.
- [`webview-ui/src/lib/activity-feed/parse-tool-arguments.ts`](src/lib/activity-feed/parse-tool-arguments.ts)
  — extracts the typed `body.toolArguments` tree first (host-supplied;
  recursive sanitization already applied). Falls back to JSON-parsing
  `body.toolInput` when the typed field is absent, and to a raw-text
  branch (`{ ok: false, rawText }`) when JSON parsing fails (truncated /
  streaming chunks). Honours the host-side `{__elided:true}` /
  `{__truncated:true,originalBytes:N}` sentinels.
- [`webview-ui/src/lib/activity-feed/detect-metadata-line.ts`](src/lib/activity-feed/detect-metadata-line.ts)
  — splits sanitized `systemSummary` / `resultSummary` strings into typed
  `MetadataLine` records. Recognised keys: `cwd`, `session_id`,
  `duration_ms`, `cost` / `total_cost_usd`, `tools`, `model`, `num_turns`.
- [`webview-ui/src/lib/activity-feed/detect-audit-footer.ts`](src/lib/activity-feed/detect-audit-footer.ts)
  — locates the `=== SCHEGENT AUDIT LOG ===` … `=== END SCHEGENT AUDIT
  LOG ===` block (start-of-line, not a partial of a wider equals fence)
  and extracts the `[SCHEGENT_STATUS: …]` status. Returns the matched
  block plus prefix/suffix so the renderer can render
  `prefix → AuditCompletionCard → suffix` and gracefully handles the
  streaming case where the close marker has not yet arrived.

**Component family** under [`webview-ui/src/components/PhaseLogFeed/parts/`](src/components/PhaseLogFeed/parts/):

- [`MultiLineCodeBlock.svelte`](src/components/PhaseLogFeed/parts/MultiLineCodeBlock.svelte)
  — renders multi-line text inside `<pre><code>` with horizontal scroll,
  a Copy affordance, and an Expand toggle for blocks over 800 lines.
- [`ToolCallCard.svelte`](src/components/PhaseLogFeed/parts/ToolCallCard.svelte)
  — replaces the inline `▶ Tool {json}` for `tool-use` entries with a
  structured key-value card. Scalar arguments render inline; multi-line
  string arguments embed a `MultiLineCodeBlock`; arrays render as
  capped lists with a `+K more` overflow pill; depth-1 objects render
  as a nested `<dl>`. Carries a "truncated" pill when the host clipped
  `toolArguments` at `perFieldBytes`.
- [`MetadataStrip.svelte`](src/components/PhaseLogFeed/parts/MetadataStrip.svelte)
  — collapsed-by-default sticky strip at the top of
  [`PhaseLogReadingPane.svelte`](src/components/PhaseLogFeed/PhaseLogReadingPane.svelte).
  Aggregates `MetadataLine` records detected across the iteration's
  `system` / `result` entries; **latest-value-wins** dedup; expand
  toggle reveals the full ordered detection list.
- [`AuditCompletionCard.svelte`](src/components/PhaseLogFeed/parts/AuditCompletionCard.svelte)
  — renders a colored status badge (CLEAR / FAILED / UNKNOWN) wrapping
  the audit-log block body inside `MultiLineCodeBlock`. Rendered inline
  from [`PhaseLogEntry.svelte`](src/components/PhaseLogFeed/PhaseLogEntry.svelte)
  when the `assistant-text` body matches the audit footer.

**Security invariants** (enforced by automated regressions, not review):

- **No `{@html}` for operator-influenced strings (FR-017).** The lint
  regression at
  [`../tests/lint/no-html-interpolation-in-activity-feed.test.ts`](../tests/lint/no-html-interpolation-in-activity-feed.test.ts)
  greps every `.svelte` file under
  [`webview-ui/src/components/PhaseLogFeed/`](src/components/PhaseLogFeed/)
  for the literal `{@html` token and fails the build on any match.
- **Single sanitization point.** String leaves under
  `PhaseLogDisplayEntry.body.toolArguments` flow through the recursive
  walker in [`../src/services/phase-log/phase-log-reader.ts`](../src/services/phase-log/phase-log-reader.ts),
  which delegates each leaf to the injected `SanitizedLogger.sanitize`.
  No webview-side sanitizer is permitted; double-sanitization is
  forbidden.

## Build

```bash
npm run build:webview   # vite build — emits dist/webview/{sidebar.js,dashboard.js,sidebar.html,dashboard.html} (and index.html)
```

The host calls this transitively via `npm run build`. Output lands in `dist/webview/`. The host's `src/ui/sidebar/html.ts` and `src/ui/dashboard/dashboard-html.ts` swap `__CSP__` and `__NONCE__` placeholders and rewrite asset URLs through `webview.asWebviewUri`.

## CSP

Both webviews load with strict CSP, identical policy:

```
default-src 'none';
img-src ${cspSource} data:;
script-src ${cspSource} 'nonce-${nonce}';
style-src ${cspSource} 'unsafe-inline';
```

There are no remote `script-src` permissions. Inline scripts are nonced. CSP regression is covered by `tests/integration-host/csp.host.test.ts` (sidebar) and `tests/unit/ui/dashboard/dashboard-csp.test.ts` (dashboard).

## Constraints

- **Bundle budget**: each entry's emitted JS ≤ 200 KB (enforced by `tests/unit/ui/sidebar/bundle-size.test.ts`).
- **No inline scripts** bypass the nonce — host renderers inject the nonce, host `csp.ts` denies `unsafe-inline` for `script-src`.
- **Read-only on host state**: the store is driven exclusively by `STATE_SNAPSHOT` messages from the host. The webview never mutates run/queue/lock state directly. To request a state change, send a typed `WebviewCommand`.
- **No `{@html ...}`** unless the source is a host-sanitized string. User-controllable strings (`lastErrorSummary`, `pausedReason`, audit summaries) are sanitized at the host before they cross the IPC boundary.

## Tests

Vitest + jsdom + @testing-library/svelte. Component and integration tests cover:

- Sidebar zones: `StatusBar`, `StatsStrip`, `CurrentTask`, `DashboardLink` (one test file each, plus `App.compact.test.ts` and `App.empty-state.test.ts` for the wiring).
- `derive-stats.ts` pure-helper math (counter formulae, active-phase rule).
- Dashboard components: phase tile rendering, queue list reorder + status badges, history section, monitor pill, control panel, queue actions.
- Activity feed sanitization (host-provided sanitized strings only).
- Snapshot store reactivity.
- a11y/theme audit (every `.svelte` component uses theme tokens, no hardcoded hex/rgb/named colors).

Run with `npm test` from the repo root (delegates to webview-ui via the `postinstall`-installed dependencies).

## Architecture context

For the host-side picture (workflow controller, runner, queue, monitor, audit pipeline, IPC, persistence), see [`../ARCHITECTURE.md`](../ARCHITECTURE.md).
