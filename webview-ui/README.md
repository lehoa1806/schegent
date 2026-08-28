# Schegent Webview UI

Svelte 5 + Vite 7 app that renders both the Schegent **sidebar** and the **dashboard** inside VS Code webviews. A single Vite build produces two HTML entry points; the host's renderer wires each into its own webview panel.

## Ownership

| Surface | Entry | Purpose |
|---|---|---|
| Sidebar | `webview-ui/src/App.svelte` (mounted via `index.html`) | Compact, non-scrolling **status bar** (~160px). Four zones: Status Row, Stats Strip (done/pending/failed counters + active phase line), Current Task (freshness + activity + optional CLI monitor row), and a single **Open Dashboard** button. |
| Dashboard | `webview-ui/src/dashboard/App.svelte` (mounted via `dashboard.html`; route components live under `webview-ui/src/components/`) | Full-window operator console: queue management across up to twenty queues, pending-task edit/reorder, history rerun, monitor tail, audit drill-in, controls (cancel / resume / retry-active-run), phase tiles. All previously-sidebar capabilities live here. Its `runs` route owns the **launch surface** — the one place a run is started (spec 102). |

The Dashboard's default route (`operations`) is itself three drill-down tiers (see "Drill-down locations under `operations`" below). Feature 097 deleted `Dashboard.svelte` and its subtree and redistributed its content: tier 2 (`drilldown/QueueDetailTier.svelte`) now owns the task list (`QueueDetailRows.svelte`), queue controls (`QueueControls.svelte`), the on-demand task composer, and the scheduled-start indicator (`QueueIdlePendingPanel.svelte`); tier 3 (`drilldown/RunDetailTier.svelte`) now owns a single run's phase progression, phase log feed, and outputs.

Both webviews subscribe to the same host `WorkflowSnapshot` projected by `src/ui/sidebar/state-projector.ts`. The dashboard renders the full operator surface; the sidebar projects a strict subset of the same `WorkflowSnapshot` (see `contracts/sidebar-view-contract.md` in the active spec for the testid contract).

## Layout

```
webview-ui/
├── src/
│   ├── App.svelte        — sidebar root (compact 4-zone layout)
│   ├── main.ts           — sidebar entry
│   ├── dashboard/        — dashboard entry, routes, and dashboard shell CSS
│   ├── components/       — shared Svelte 5 components (StatusBar, StatsStrip,
│   │                       CurrentTask, DashboardLink, plus dashboard-only:
│   │                       HistorySection, ConfirmDeleteDialog, etc.
│   │                       Feature 030 removed the multi-queue
│   │                       QueueManagementPanel and QueueDeleteModal
│   │                       surfaces; Feature 092 reinstated multi-queue
│   │                       operation as OperationsSurface + drilldown/,
│   │                       not by restoring either removed component.
│   │                       FR-R3-140 deleted PhaseTracker, ControlPanel,
│   │                       QueueList and MonitorPill, which this list still
│   │                       named after they had stopped being reachable
│   │                       from either entry point.)
│   │   ├── drilldown/    — QueuesTier / QueueDetailTier / RunDetailTier,
│   │   │                   the three tiers OperationsSurface routes between
│   │   └── Runs/         — the launch surface RunsSurface mounts: the two
│   │                       Launchable* components, WorkflowTriggerForm, and
│   │                       the pure launch-selection state (spec 102)
│   └── lib/
│       ├── derive-stats.ts — pure helper: deriveSidebarStats / deriveActivePhase
│       ├── deletion-confirmation.ts — status-aware destructive confirmation copy
│       ├── messages.ts   — re-exports from src/contracts/sidebar-ipc.ts
│       ├── snapshot-store.svelte.ts — latest WorkflowSnapshot + pending-correlation ids
│       ├── snapshot-types.ts — re-exports of host-projected types
│       ├── vscode-api.ts — typed postCommand / onHostMessage
│       └── theme.css     — --schegent-* tokens with --vscode-* fallback
├── index.html            — sidebar HTML shell (CSP placeholders)
└── dashboard.html        — dashboard HTML shell (CSP placeholders)
```

## IPC contract

Webview → host commands and host → webview snapshots are typed in `src/contracts/`:

- Webview → host: `SidebarCommand` (discriminated union) — see `src/contracts/sidebar-ipc.ts`.
- Host → webview: `WorkflowSnapshot` — see `src/ui/sidebar/snapshot.ts` and the mirrored webview types in `webview-ui/src/lib/snapshot-types.ts`.
- Validation: `MessageRouter` validates every inbound command via `src/contracts/runtime-validators.ts`. Unknown shapes are rejected and audited as `audit.invalid_command`.

The webview's command literal types are re-exported from `src/contracts/`. There is no separate webview-side definition.

Spec 102 adds `WorkflowSnapshot.launchables` in that direction and nothing new
in the other: the launch surface starts runs through the command shapes that
already existed. `lib/workflow-run-ipc.ts`'s `launchWorkflow()` shipped in spec
088 with no caller and now has one — `components/Runs/WorkflowTriggerForm.svelte`.
The payload it sends carries **no `catalogVersion`**; provenance is resolved
host-side inside `validateRunRequest()` and a payload asserting its own is
refused (`tests/contract/catalog-version-not-accepted.test.ts`), so this is a
field the webview never learns to send rather than one the host strips.

### Dynamic pipelines (spec 009)

The phase-tracking IPC shape was widened to support operator-defined pipelines:

- `PhaseName` is `string` (was a fixed literal union of the eight built-in phases). Webview components must not assume any specific phase id list.
- `PhaseTile.order` is `number` (was a 1..7 tuple). Tiles render in catalog order, with vertical scroll when the active pipeline exceeds ~10 phases.
- `PhaseTile.loopable?: boolean` is now optional, mirroring the per-phase `PhaseDef.loopable` setting.
- `WorkflowSnapshot.activePipeline?: { id: string; name: string }` is optional. When present, the dashboard header renders `Phase Progression — Pipeline: <name>`; when absent, no Pipeline is named.

Feature 098 removes the fallback these bullets used to describe. There is no built-in Pipeline left to imply and no built-in phase-id list to fall back to, so absence now means absence: the webview renders what the projection carries and infers nothing from a missing field. `snapshot-types.ts` lost `BUILT_IN_PHASE_NAMES`, `PHASE_NAMES`, and `BuiltInPhaseName` with the layer they mirrored (T040) — `PhaseName` stays `string` on both sides of the boundary, which is the parity the file exists to hold. `IDLE_GENERAL_SETTINGS.defaultPipelineId` is `''` for the same reason (T048): the empty string is how "no default" is spelled across the boundary, not a missing field, and the host default, the manifest contribution, and this idle snapshot all agree on it.

### Per-queue snapshot, `schemaVersion` 4 (spec 092)

`WorkflowSnapshot.schemaVersion` advanced `3 → 4`. A queue is no longer a
singleton, so "the" Run is no longer a thing the root can publish:

- **`queues: readonly QueueRuntime[]`** — one entry per registry entry, in
  position order. Each carries its own `lifecycle`, `phases`,
  `phaseOverrides`, `manualPause`, `phaseBreakpoints`, `pendingCount`,
  `tasks`, and an `inFlightRun: InFlightRunProjection | null` holding the
  run-scoped readings (`runId`, `status`, `feature`, `pipeline`,
  `elapsedMs`, `liveActivity`, `delayedRetry`, `resumeTargetPhaseId`,
  `outputs`).
- **The v3 top-level per-run singulars were deleted, not deprecated.** There
  is no compatibility shim and no fallback: a webview reading `snapshot.status`
  or `snapshot.phases` fails to compile, which is the point — the compiler
  locates every consumer that still assumes one Run.
- **`isPrimary` stays at the root.** It is a property of this window against
  the workspace, not of any queue.
- **`auditTail` and `debugLogTail` stay at the root too, unpartitioned.** A
  line with no Run — a state migration, a queue mutation — belongs to no
  queue and must not be dropped. Per-queue scoping is a read-side join on
  `inFlightRun.runId`, not N partitioned copies.
- **A queue with no Run publishes `inFlightRun: null`** — the empty
  projection, never a borrowed neighbour's.

Read seams for that shape live in `webview-ui/src/lib/`:
`queue-runtime-view.ts` (`findQueueRuntime` — a caller must still name which
queue's Run it means), `queue-run-rows.ts` (folds a connected run into one
row per FR-047), and `queue-lifecycle-label.ts`.

Seven queue mutation commands feature 030 removed were reinstated in
`src/contracts/sidebar-ipc.ts` by feature 092; five still stand —
`CMD_CREATE_QUEUE`, `CMD_RENAME_QUEUE`, `CMD_DELETE_QUEUE`,
`CMD_SAVE_QUEUE_SETTINGS`, `CMD_MOVE_TASK`. The other two,
`CMD_SET_QUEUE_SCHEDULE` and `CMD_CLEAR_QUEUE_SCHEDULE`, were deregistered
again by feature 097 — not merely hidden — so neither has a
`MUTATING_COMMAND_REASONS` entry, a validator, or a handler any more. Every
one of the five standing commands is a member of `MUTATING_COMMAND_TYPES`
(`src/contracts/sidebar-command-metadata.ts`), so every one is primary-host
gated, and every one has a host handler under `src/ui/sidebar/commands/`.
`CMD_REORDER_TASK` still drives both drag-and-drop and the up/down arrows
*within* a queue; `CMD_MOVE_TASK` is the across-queues move.

All five now have webview call sites. Feature 092 shipped them with
none — handler, validator, refusal codes and audit events on the host, and
nothing in any tier that posted them — and feature 095 added the controls:

| Command | Control | Component |
|---|---|---|
| `CMD_CREATE_QUEUE` | New Queue | `drilldown/QueuesTier.svelte` |
| `CMD_RENAME_QUEUE` | Settings | `drilldown/QueueDetailTier.svelte` |
| `CMD_DELETE_QUEUE` | Delete | `drilldown/QueueDetailTier.svelte` |
| `CMD_SAVE_QUEUE_SETTINGS` | Queue Settings | `QueueConfigModal.svelte` |
| `CMD_MOVE_TASK` | Move to… | `drilldown/QueueDetailTier.svelte` |

The commands feature 095 wired post from **one** module,
`webview-ui/src/lib/queue-control-ipc.ts`, on the same correlated-request terms
as `phase-log-ipc.ts` and `save-general-settings.ts`. The two that already had
call sites keep them; relocating working code to make the rule uniform would be
a diff with no requirement behind it.
`tests/lint/queue-command-reachability.test.ts` derives the mutating
queue-command set from `MUTATING_COMMAND_REASONS` and fails the build if any
member has no non-test call site — the gap is now checked rather than recorded.

Only one schedule mechanism remains. Feature 092's `CMD_SET_QUEUE_SCHEDULE`
wrote `QueueRegistry.entries[].schedule`, was paired with no lifecycle, and
surfaced in `QueueDetailTier` as Arm/Re-arm/Disarm controls; feature 097
removed it and its controls entirely. The feature 065 **lifecycle** scheduled
start — which writes `QueueState.scheduledStartAt`, is paired with
`queueLifecycle === 'idle-pending'`, and surfaces in
`ScheduledStartIndicator.svelte` (relocated onto tier 2, inside
`QueueIdlePendingPanel.svelte`, by feature 097) — is now the only way to arm a
future start.

Per-queue **pause and resume** are not part of the five: `CMD_PAUSE_QUEUE` /
`CMD_RESUME_QUEUE` take an optional `queueId`. `drilldown/QueueDetailTier.svelte`
posts them scoped to its own `queueId`, and that is now the only sender.
`QueueGlobalActions.svelte` posted them unscoped; FR-R3-140 deleted it, so the
optional `queueId` currently has no caller that omits it — the host contract
still accepts one, and the parameter stays optional rather than being narrowed
on the strength of a single deletion.

### Per-queue Run projection (spec 093)

`schemaVersion` stays at **4**. Feature 092 gave the snapshot a shape with room
for one Run per queue while the engine still had exactly one Run to put in it;
093 made the Runs genuinely distinct and the wire shape needed no change. That
no component was edited to consume N Runs is the evidence 092's shape was the
right one — the churn is entirely on the host side of the boundary:

- **Attribution is a keyed lookup, not a scan.** `queue-runtime-composer.ts`
  used to ask each queue "do you hold a row whose id is `run.featureId`?"; it
  now calls `runOf(queueId)`, because the Run record is itself keyed by queue.
  With N Runs the old scan would have run N times per queue for an answer the
  key already holds.
- **The row-projection context is per queue, run-scoped readings included.**
  092 substituted only each queue's `inFlightId` and scheduled-start into one
  shared context, so every queue's in-flight row inherited the window Run's
  phase and pause cause. Harmless with one Run; a visible cross-queue leak with
  several. `rowContextFor(queueId, state)` is now built per queue.
- **`runOf` is memoized per snapshot.** Two callers ask for the same queue — the
  runtime list and the row projections — and `decoratePhases` mutates the tiles
  it is handed, so an unmemoized second build would hand out a second set of
  tile objects free to disagree with the first.
- **`snapshot.queue` is still the default queue's compat projection**
  (`projectQueue(queue, rowContextFor(DEFAULT_QUEUE_ID, queue))`). Anything
  reading it reads `default`, whatever else is executing. That is why
  `resolveLiveSelection` in `lib/activity-feed-selection.svelte.ts` follows the
  default queue's Run: follow-live tracks one Run by construction, and the
  drill-down tiers are the surface for watching a specific one among several.
- **Every lifecycle control names its queue.** `lib/phase-control.ts` and
  `lib/phase-breakpoint-ipc.ts` take a required `queueId` — the host refuses an
  unaddressed control at the IPC boundary, so a component that cannot say which
  Run it is acting on has no business posting the command. Retry-now stays out
  of the lib module: its `postCommand` must share a scope with the `useConfirm`
  that gates it, which needs component-level context. It was dispatched inline
  in `PhaseTracker.svelte`, which FR-R3-140 deleted as unreachable, so no
  webview component sends it today — the rule for where it would live is
  unchanged, and only the example is gone.

**The aggregate status bar is a host surface, not this app's `StatusBar`.**
`src/ui/status-bar.ts` owns the VS Code window status bar item and, since 093,
summarizes across Runs: a plural count (`schegent: 2 runs`, `3 stalled`) when
several share a state, `running` outranking `stalled` outranking `paused` when
they differ, and one tooltip line per live Run with its phase and iteration. It
names no queue. `components/StatusBar.svelte` is the sidebar's own Status Row
zone and is unchanged — the two are different surfaces with the same word in
their names, so check which one a task means before editing.

### Sidebar outbound surface

The compact sidebar emits **only** `CMD_OPEN_DASHBOARD`. Any other operator-initiated mutation (cancel, resume, queue actions, history rerun, retry-active-run) is sent from the Dashboard webview or the VS Code Command Palette. This narrow surface is enforced by `tests/integration/sidebar-activation.host.test.ts`, which scans the sidebar bundle and asserts the four allowed `data-testid` containers (`sidebar-status-row`, `sidebar-stats-strip`, `sidebar-current-task`, `sidebar-open-dashboard-button`) plus `app-root` and rejects any reappearance of removed sidebar testids.

### Top-level routes (spec 012 / spec 064)

The Dashboard exposes seven peer top-level routes from
`dashboard/App.svelte` (the legacy two-tier `Operations / Settings` parent
with inner tabs is gone; Feature 064 added `System` as a sibling between
`Pipeline Builder` and `Settings`, and Feature 091 added `Runs` directly
after `Operations`). The route ids and their nav labels are declared in
`dashboard/routes.ts`:

| Route (id) | Nav label | Component | Purpose |
|---|---|---|---|
| `operations` | Queues | `components/OperationsSurface.svelte` | The three drill-down tiers (spec 092). Tier 2 (`drilldown/QueueDetailTier.svelte`) renders the task list, queue controls, an on-demand composer, and the scheduled-start indicator; tier 3 (`drilldown/RunDetailTier.svelte`) renders one run's phase progression, phase log feed, and outputs. Feature 097 deleted `components/Dashboard.svelte`, which tier 2 embedded until then. |
| `runs` | Runs | `components/RunsSurface.svelte` | The launch surface — Pipelines and Workflows, each listing only Active definitions, with an explicit select → Trigger → fulfil inputs → Run flow — plus connected composed runs and the Run composer. See "Connected-run surfaces" and "The launch surface" below. |
| `history` | History | `components/HistoryDashboard.svelte` | Completed-run history and rerun. |
| `metrics` | Metrics | `components/MetricsDashboard/MetricsDashboard.svelte` | On-demand audit-log rollup (spec 073). |
| `system` | System Log | `components/SystemTab.svelte` | **System-scoped audit entries** (lifecycle, queue/task control, scheduling, audit pipeline housekeeping). See "Audit surfaces" below. |
| `builder` | Builder | `components/PipelineBuilder.svelte` | Pipelines, phases, and models editor with `RetryConditionEditor` / `RawJsonPhaseEditor` wiring. |
| `settings` | Settings | `components/SettingsSurface.svelte` | Two sub-tabs: **General** and **Fatal Signatures**. |

`DEFAULT_DASHBOARD_ROUTE` stays `operations` through every such addition —
a new surface earns its place in the nav, not on someone's landing page.
Every route but the default is lazily loaded through the `routeLoaders`
dynamic-import map. `operations` is the exception because it is where the
dashboard lands, so `OperationsSurface` makes the same bargain one level down:
tier 1 is synchronous, and tiers 2 and 3 — which between them pull in
the phase log feed and the `WorkflowRun` topology view — are imported on
descent. An operator who never drills in never loads them.

Single subscription to `snapshotStore` is in `dashboard/App.svelte`
(`$derived(snapshotStore.snapshot)`); every route receives the snapshot
as a `{snapshot}` prop (the System route reads `auditTail` directly
from the store).

### Drill-down locations under `operations` (spec 092)

The three tiers are **sub-locations beneath one route**, not nav peers.
`DashboardRoute`, `DASHBOARD_ROUTES` and `DEFAULT_DASHBOARD_ROUTE` are
unchanged by feature 092 — promoting a single-queue view and a single-run view
to siblings of Settings would put tier-2 and tier-3 surfaces in tier-1's nav.
`dashboard/routes.ts` gains a second, independent union:

| Location | Fields | Tier |
|---|---|---|
| `QueuesLocation` | `route: 'queues'` | 1 — every queue |
| `QueueDetailLocation` | `route: 'queue-detail'`, `queueId` | 2 — one queue |
| `RunDetailLocation` | `route: 'run-detail'`, `queueId`, `runId` | 3 — one Run |

`DashboardLocation` is their union; `DEFAULT_DASHBOARD_LOCATION` is tier 1.
Constructors (`queueDetailLocation`, `runDetailLocation`) return their own
member rather than the union, and `parentLocation` gives the tier a back
navigation lands on — tier 1 is its own parent, so callers need no
"anywhere left to go" check. A location carries exactly the ids its tier
displays: tier 3 keeps `queueId` alongside `runId` so back-navigation is a
field read rather than a lookup that can fail.

`components/OperationsSurface.svelte` is the only holder of a
`DashboardLocation`, and owns two things nothing else does:

- **Resolution.** A location is operator state and the snapshot is host
  state, so a destination can stop existing between snapshots. The rendered
  tier is *derived* from both — `resolveLocation` walks up to the nearest
  surviving tier — rather than the location being mutated, so there is no
  write-during-update and a destination that reappears resolves again on its
  own.
- **Position.** One scroll container for all three tiers with the offset
  remembered per location key, so walking back lands where the operator was.
  Selection is passed back down the same way; the tiers store none of it.

Each tier receives `isPrimary` from the snapshot root and offers no mutating
control without it. Travel between tiers stays available in a non-primary
window — reading is not a mutation.

### Connected-run surfaces (spec 091)

`components/RunsSurface.svelte` mounts the two components specs 087 and 088
shipped complete and that nothing outside their own tests imported:

| Component | Role |
|---|---|
| `components/WorkflowRun/WorkflowRun.svelte` | One connected run — identifiers, per-node states with actions, run status, and the continuation composer for a picked node. |
| `components/RunLauncher/RunLauncher.svelte` | Compose a new run against a Pipeline picked from `availablePipelines`. |

`RunsSurface` adds **no IPC command and no store subscription**. Everything it
renders was already in the projection — `connectedRuns`, `queue.orderedItems`,
`availablePipelines` — and the webview simply never read it. Both children read
zero stores and take everything as props, so the wrapper stays the thinnest
thing that can mount them: no derived state beyond what the markup branches on,
and no second opinion about behaviour the children already own.

Two non-decisions are load-bearing. A hydrating run is passed straight through
rather than filtered — `WorkflowRun` renders the loading state, and pre-filtering
would show the operator a run vanishing instead of a run loading. And the
composer stays closed until asked for, with the picker shown only when the
catalog has something to pick, because a live compose control over an empty
catalog is a control whose only outcome is a refusal.

Feature 098 revises the second of those in one direction and leaves it standing
in the other. The picker still appears only when there is something to pick, but
the **Start a Run** zone now stays mounted with nothing imported and shows the
empty-catalog guidance in place of the choices
(`data-testid="runs-surface-empty-catalog"`). Hiding the whole zone was right
when an empty catalog was a transient state of a product that shipped Pipelines;
it is wrong now that it is the state every install starts in, because it left the
operator no visible route from an empty catalog to a non-empty one and left
`RunLauncher.svelte` reachable from nowhere. The text comes from
[`src/contracts/empty-catalog-guidance.ts`](../src/contracts/empty-catalog-guidance.ts),
imported rather than restated, and both call sites go through
`emptyCatalogGuidance(count)`, which returns the guidance only when the count is
zero — so the empty state is derived from the projection and never stored as a
second flag to keep in step.

**This zone is the only instance, full stop.** It used to be only the only
*operator-visible* one: `PhaseTracker.svelte` rendered the same text from the
same source (`data-testid="phase-tracker-empty-catalog"`) while sitting in the
reachability `ALLOWLIST` as *"Superseded by RunDetailTier's phase list"*,
retired before feature 098 and imported by no panel root. FR-R3-140 deleted the
component and emptied that allowlist, so the qualifier has nothing left to
exclude. The live phase
strip is `drilldown/RunDetailTier.svelte`, which reads `runtime?.phases` and is
reachable only once a run exists, so it has no empty-catalog case to answer. The
host side is what makes the idle surface honest: `buildPhasesFromRun(null)`
returns **zero tiles** rather than the seven placeholders `buildEmptyPhases()`
used to invent (T055), so an idle tracker no longer claims a catalog that is not
there.

**A shipped `.svelte` view with no import path from a panel root now fails a
test.** `tests/lint/svelte-surface-reachability.test.ts` walks from the two
panel entry points, `src/main.ts` and `src/dashboard/main.ts`, across four
specifier shapes — `from
'…'`, bare `import '…'`, `import('…')`, and extension-less specifiers resolved
by trying `.ts`, `.svelte.ts`, `.svelte`, `/index.ts` — through `.ts` files as
well as `.svelte` ones, since two real edges (`lib/use-confirm.ts` →
`ConfirmDialog.svelte`, `hover-text-anchor-action.ts` → `HoverTextPortal.svelte`)
pass through TypeScript. `__tests__/` is skipped as both node and edge, so a
component reachable only from its own test counts as unreachable. Deliberately
retired components sit in a 10-entry `ALLOWLIST`, each with a recorded reason;
`WorkflowRun.svelte` and `RunLauncher.svelte` may never be added to it.

### The launch surface (spec 102)

Runs is now where work is **started**, and the only place it is started.
`components/Runs/` is a new owned directory under `RunsSurface`:

| Module | Role |
|---|---|
| [`LaunchableSection.svelte`](src/components/Runs/LaunchableSection.svelte) | One section — Pipelines or Workflows — listing only definitions with an active version |
| [`LaunchableRow.svelte`](src/components/Runs/LaunchableRow.svelte) | One offered definition and its **Trigger** control |
| [`LaunchableDetail.svelte`](src/components/Runs/LaunchableDetail.svelte) | The selected definition's trigger panel |
| [`WorkflowTriggerForm.svelte`](src/components/Runs/WorkflowTriggerForm.svelte) | Fulfil a Workflow's derived inputs, then Run — the first call site `launchWorkflow()` has ever had |
| [`launch-selection.ts`](src/components/Runs/launch-selection.ts) | Pure selection state: which definition is picked, across both sections |

The flow is explicit at every step — select, Trigger, fulfil inputs, Run — and
nothing starts on a click that was not the last one. The two sections read
`snapshot.launchables`, which the host projects (see ARCHITECTURE.md, "Launch
projection"); the webview derives no second list of its own, and a **missing**
`launchables` is the loading arm rather than an empty catalog.

Two contract facts the webview does not get to bend. A launch payload carries
**no `catalogVersion`** — provenance is resolved host-side inside
`validateRunRequest()`, and a payload arriving with one is refused rather than
sanitized. And a Workflow's trigger inputs are the host's derived ports,
recomputed per open and never persisted, so a form opened after a node's
Pipeline changed shape asks for the new ports and not the old ones.

The restructure moved both older components rather than retiring them.
`WorkflowRun.svelte` and `RunLauncher.svelte` are still mounted from
`RunsSurface.svelte` and still absent from the reachability `ALLOWLIST` — a
restructure that quieted the gate by allowlisting them would have deleted the
surfaces in every sense but the file listing.

### Settings sub-tabs (spec 012 reduction)

| Sub-tab | Component | Purpose |
|---|---|---|
| General | `components/settings/GeneralSettingsTab.svelte` | Renders every scalar `schegent.*` key from `snapshot.generalSettings` with adaptive form controls (boolean → checkbox, string → text, number → number, enum → dropdown, optional integer → number-with-clear) and a scope indicator (workspace / user / default). Save goes through the shared `lib/save-general-settings.ts` helper. |
| Fatal Signatures | `components/settings/FatalSignaturesTab.svelte` | Two sections: the read-only **Built-in registry** (rendered from the parity mirror at `lib/fatal-signature-registry.ts`) and the editable **Operator additions** list (text inputs with + Add / Remove controls). Save goes through the shared helper with the unprefixed key `fatalSignatures`. |

Feature 030 (US3) removed the **Queue** sub-tab and its
`QueueSettingsTab.svelte` / `save-queue-settings.ts` plumbing, on the
grounds that `MAX_QUEUES = 1` made a per-queue cap and a default-queue
selector meaningless. Feature 092 raised `MAX_QUEUES` back to 20 but did
**not** restore the sub-tab: per-queue configuration is reachable from the
Queue Detail tier (FR-064), and `schegent.queue.globalConcurrencyCap` — now
ranged `1..20`, default `3` — stays in **General** alongside the other
scalar `schegent.*` keys.

The Phases, Pipelines, Workflows, and Models editors are not in
`SettingsSurface` — they live in Pipeline Builder, as its four tabs
(Pipelines / Phases / Workflows / Models, per spec 083 and spec 096). This
co-locates configuration with the workflows that consume it.

### Settings hover-text primitive (spec 018)

Every focusable control in the Settings sub-tabs is annotated by
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
payload can shift surface as the copy is tuned. The action is the only
form. `<HoverText>` was the advanced/secondary component this paragraph
used to point at, and FR-R3-140 deleted it: no shipping call site
imported it from either bundle entry point, so the old advice that "most
call sites should use the action" was already describing a tree where
every call site did. What remains under
[`components/hover-text/`](src/components/hover-text/) is the action's own
machinery — the anchor action, the positioning helper, the shared types,
and
[`HoverTextPortal.svelte`](src/components/hover-text/HoverTextPortal.svelte),
which the action mounts to render the popover.

Descriptions live in per-tab sibling modules —
`GeneralSettingsTab.descriptions.ts` and
`FatalSignaturesTab.descriptions.ts` — each frozen with
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
surface. Feature 092 reinstated all seven; feature 097 deregistered two of
them again (`CMD_SET_QUEUE_SCHEDULE`, `CMD_CLEAR_QUEUE_SCHEDULE`), so five
stand today (see "Per-queue snapshot" above). Feature 092 also gave
`CMD_PAUSE_QUEUE` / `CMD_RESUME_QUEUE` an optional `queueId`; the unscoped
call still carries no payload at all.

Feature 022 widens deletion commands:

- `CMD_REMOVE_QUEUE_ITEM` requires `{ id, confirmed: true }` and can remove
  any task status after `ConfirmDeleteDialog.svelte` confirmation.
- `CMD_REMOVE_TASK_PHASE` requires `{ taskId, phaseId, confirmed: true }` and
  removes a task-scoped phase override without changing the global pipeline.

The new-task compose box and position selector `Dashboard.svelte` used to own
now live in `drilldown/QueueDetailTier.svelte`'s on-demand composer; its
per-queue controls (Pause / Resume / Clear Done / Clean All) live in
`QueueControls.svelte`, mounted in the same tier. `Dashboard.svelte` itself
was deleted by feature 097. `QueueItemActions.svelte` owns task
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

- `CMD_SAVE_GENERAL_SETTINGS` — payload `{ updates: Record<key, value> }`. Host validates every key against `ALLOWED_KEYS` in `src/config/general-settings.ts` before writing and uses compensating rollback if a later workspace write fails. Webview pre-validates for UX but the host is the source of truth.
- `CMD_RETRY_PHASE_NOW` — payload `{ runId: string }`. Host cancels the watchdog timer, resets `delayedRetryCount`, optionally unpauses the queue (only when `pausedReason` matches `retry-cap-exhausted:<runId>`), and re-runs the phase within ~1 s.

Both commands are members of `MUTATING_COMMANDS` in `src/ui/sidebar/message-router.ts`. The primary-only gate rejects mutations from secondary VS Code windows with reason `secondary-window-readonly`.

**Feature 056 Track 1 (FR-001..FR-005)** reclassified the three catalog
saves (`CMD_SAVE_PIPELINES`, `CMD_SAVE_PHASES`, `CMD_SAVE_MODELS`) and
the general-settings save (`CMD_SAVE_GENERAL_SETTINGS`) as mutating:
they all write VS Code workspace configuration and must follow the
same primary-only gate. Secondary windows now receive `status:
'rejected'`, `reason: 'secondary-window-readonly'` for every catalog
save attempt; the regression coverage lives at
[`../tests/unit/ui/sidebar/save-commands-primary-gate.test.ts`](../tests/unit/ui/sidebar/save-commands-primary-gate.test.ts).
Read-only commands stay outside `MUTATING_COMMANDS` but still apply
their own primary-host handler gate (`reason: 'not-primary-host'`) —
that path is unchanged.

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

### Scoped Phase catalog manager (spec 081)

[`PipelineBuilder.svelte`](src/components/PipelineBuilder.svelte) carries
per-phase **Effort** and **Model** dropdowns plus a precedence badge
("shadowed by workspace" etc.) on each row. The Pipeline Builder
(reached via the top-level **Builder** route) remains the canonical
phase-editing surface; SettingsSurface intentionally does **not** carry
a Phases tab (spec 012 reduction).

The component reads the authoritative `snapshot.phaseCatalog` source-record
projection. It renders built-in, user, and workspace rows separately with
effective/shadowed/invalid status, bounded errors, revisions, and unavailable
models. `availablePhases` remains the effective runtime-only list. Built-ins are
read-only; drafts select user or workspace scope explicitly.

`webview-ui/src/lib/save-phases.ts` was the **single call site** for
`CMD_SAVE_PHASES` in the webview (FR-021 + research Decision 1). Feature 101
deleted it along with the command it wrapped (see the feature 101 amendment
below); what survives is the single-call-site property, now held by
[`catalog-lifecycle.ts`](src/lib/catalog-lifecycle.ts). The behavior it
described, for the record: components called
`await savePhases({ scope, expectedRevision, mutation, phases })` rather than
constructing the envelope inline. The helper preserved structured accepted and
rejected acknowledgement details and mirrored the correlation behavior of
[`save-general-settings.ts`](src/lib/save-general-settings.ts), which
`catalog-lifecycle.ts` still follows step for step:

1. Generates a UUIDv4 correlation id.
2. Posts the envelope through `postCommand`.
3. Awaits the matching `CMD_ACK` (5-second timeout → typed timeout
   reject).
4. Concurrent saves are correlated by id and never cross-resolve.

Saves contained exactly one create/edit/duplicate/remove/reset intent and the
complete target layer. Delete additionally awaited
`useConfirm('catalog.remove-phase', ...)`. The UI remains pending until a
snapshot publishes the accepted revision.

**Amended by feature 100 (FR-R3-016), T509b.** `CMD_SAVE_PHASES` is retired, so
`no-inline-save-phases.test.ts` is gone with it and the single-call-site property
moved to
[`../tests/lint/catalog-lifecycle-dispatch.test.ts`](../tests/lint/catalog-lifecycle-dispatch.test.ts),
which pins all six lifecycle commands to one dispatch module,
[`catalog-lifecycle.ts`](src/lib/catalog-lifecycle.ts). `save-phases.ts` still
exists and still exports `savePhases`, but it is now a **translation rather than
a transport**: it keeps the request shape this Builder already builds and hands it
to that module. A whole-layer save becomes a one-layer `CMD_PUBLISH_PACKAGE`
gated on the same `expectedRevision`; the `mutation` tag no longer travels,
because intent is declared by being the command it is — it is still read *here*
for the one thing a publish cannot express, since a `remove` is an omission from
a whole-array write and omitting a definition from a package leaves it exactly as
it was, so a removal routes to `deactivateDefinition` instead. The translation
exists so this surface keeps working while the store changes underneath it;
FR-R3-017 replaces the surface with one that speaks the lifecycle directly and
deletes `save-phases.ts`, `save-pipelines.ts`, and `save-workflows.ts` with it.

**Amended by feature 101 (FR-R3-017).** That replacement happened. The three
translation shims are **deleted**: `save-phases.ts`, `save-pipelines.ts`, and
`save-workflows.ts` no longer exist, and the editors call
[`catalog-lifecycle.ts`](src/lib/catalog-lifecycle.ts) directly —
`saveDefinitionDraft` per definition, quoting that definition's
`expectedDraftVersion` rather than a whole-layer revision. `save-models.ts` is
untouched: the Model Catalog is configuration, not a versioned definition, and it
stays outside the lifecycle (FR-041).

Everything a definition's lifecycle looks like on screen now lives under
[`src/components/Builder/`](src/components/Builder/): `DefinitionLifecycleRow`
(state badge, created/modified, active version, defects), `DefinitionActions`
(the four operations, one dispatch path), `DefinitionHistoryPanel` (the version
list and one body at a time), `ChangedFieldSummary` (what publishing would
change), and `CatalogEmptyState` (the empty-catalog front door, whose words come
from the shared `empty-catalog-guidance` constant so this surface and the Runs
surface cannot drift). Each editor mounts the row beside its own list item; the
tab shell mounts nothing per-definition. The directory is a scan root of
[`../tests/lint/no-html-interpolation-in-activity-feed.test.ts`](../tests/lint/no-html-interpolation-in-activity-feed.test.ts)
with an empty allowlist, because every string on it is document-sourced.

The scope vocabulary in the three sections below (built-in / user / workspace
layers, `shadowed` status, per-layer revisions) describes the pre-099 store and
is stale; feature 099 left one layer and feature 101 left the rows lifecycle
state where the scope badge used to be.

### Scoped Pipeline catalog manager (spec 082)

The Pipelines editor is the Phase manager's counterpart and follows the same
rules. It reads the authoritative `snapshot.pipelineCatalog` source-record
projection — built-in / user / workspace rows with effective, shadowed, or
invalid status, bounded field errors, both writable-layer revisions, warnings,
and each row's `consumingWorkflowIds`. `availablePipelines` remains the
effective runtime-only list. Built-ins are read-only and offer duplicate only.

Ownership, given `PipelineBuilder.svelte`'s 500-line component budget:

| File | Owns |
|---|---|
| [`PipelineCatalogEditor.svelte`](src/components/PipelineBuilderEditors/PipelineCatalogEditor.svelte) | The catalog list, the selected Pipeline's header/sequence markup, and the consuming-Workflow list |
| [`PipelinePortsEditor.svelte`](src/components/PipelineBuilderEditors/PipelinePortsEditor.svelte) | Declared input and output ports |
| [`PipelineFieldErrors.svelte`](src/components/PipelineBuilderEditors/PipelineFieldErrors.svelte) | Field-associated error regions (`aria-describedby` → `role="alert"`) |
| [`pipeline-catalog-state.ts`](src/components/PipelineBuilderEditors/pipeline-catalog-state.ts) | Pure draft logic — including the binding `phaseIndex` remap every reorder, insert, and remove must apply *before* revalidation |
| [`pipeline-catalog-store.svelte.ts`](src/components/PipelineBuilderEditors/pipeline-catalog-store.svelte.ts) | Rune-backed draft state and mutation dispatch |

`CMD_SAVE_PIPELINES` is widened to `{ scope, expectedRevision, mutation,
pipelines }`, matching `CMD_SAVE_PHASES`. Each row may now carry `description`,
`version`, `inputs`, `outputs`, `bindings`, `executionDefaults`, and
`recommendedNext` in addition to `id`/`name`/`phases`.
`webview-ui/src/lib/save-pipelines.ts` was the **single call site**, with the
same correlation and 5-second timeout behavior as `save-phases.ts`. Feature 101
deleted it along with the command it wrapped (see the feature 101 amendment
above); what survives is the single-call-site property, now held by
[`catalog-lifecycle.ts`](src/lib/catalog-lifecycle.ts). The repo-grep regression at
[`../tests/lint/no-inline-save-catalog.test.ts`](../tests/lint/no-inline-save-catalog.test.ts)
fails the build if a component posts the command inline. Removal awaits
`useConfirm('catalog.remove-pipeline', ...)`, enforced by
[`../tests/lint/destructive-actions.lint.test.ts`](../tests/lint/destructive-actions.lint.test.ts),
which scans for constructed `{ kind: 'remove' | 'reset' }` mutations rather than
command names, since catalog removals route through the shared helper.

The UI stays pending after a save until a snapshot arrives whose
`revisions[scope]` differs from the one submitted, or a rejection is received. A
`stale-catalog` rejection carries the authoritative row and the legal next
actions. With an empty Phase catalog the editor explains the prerequisite and
disables save rather than offering a control that cannot succeed.

### Scoped Workflow catalog manager and Graph Builder (spec 083)

The third catalog family. A **Workflow definition** is a reusable acyclic graph
of Pipeline nodes — distinct from the run-side `WorkflowRun` (a queued request
driven through one Pipeline), whose surfaces this feature does not touch. Both
senses are recorded in [`../docs/reference/glossary.md`](../docs/reference/glossary.md).

The editor reads the authoritative `snapshot.workflowCatalog` source-record
projection and nothing else — built-in / user / workspace rows with effective,
shadowed, or invalid status, bounded field errors, both writable-layer
revisions, and warnings. A Workflow's own inputs and outputs are **derived**,
never stored: an input is a node input port no connection lists in `to`, an
output is a node output port no connection lists in `from`. A stored list would
drift from the graph the moment a connection changed, so the surface is
recomputed at resolution and projection time and the rows carry no port list.

`PipelineBuilder.svelte` mounts it behind the **Workflows** tab (the Builder's
tab bar is Pipelines / Phases / Workflows / Models) and supplies the one thing
the editor may not compute for itself: the `trusted` verdict, derived from
`snapshot.resolvedTrust.workflowOverrides` under the workspace-trust ceiling.
That capability is deliberately **distinct** from `pipelineOverrides` — see
[`../docs/security/threat-model.md`](../docs/security/threat-model.md) T22 and
its per-capability trust scopes section. The webview fails closed when a host
bundle omits the field.

Ownership, given `PipelineBuilder.svelte`'s 500-line component budget:

| File | Owns |
|---|---|
| [`WorkflowCatalogEditor.svelte`](src/components/PipelineBuilderEditors/WorkflowCatalogEditor.svelte) | The Library: scope, identity fields, draft lifecycle, revision handshake, and the save |
| [`WorkflowLibraryList.svelte`](src/components/PipelineBuilderEditors/WorkflowLibraryList.svelte) | The row list, each row's node sequence, and its derived input/output ports |
| [`WorkflowToolbar.svelte`](src/components/PipelineBuilderEditors/WorkflowToolbar.svelte) | The action bar, the writable scope list it renders, the FR-045 "no effective Pipeline" explanation beside the control it disables, and Export — the one control whose own precondition (a saved row) is decided here rather than derived by the editor, because export writes nothing this extension owns and shares none of the mutation flags |
| [`WorkflowFlowCanvas.svelte`](src/components/PipelineBuilderEditors/WorkflowFlowCanvas.svelte) | The graph surface: one subtree per start, plus the separate lane for nodes no start reaches — an `unreachable-node` defect renders below rather than being hidden, because the operator has to see the node the host's defect points at |
| [`WorkflowFlowSubtree.svelte`](src/components/PipelineBuilderEditors/WorkflowFlowSubtree.svelte) | One card and everything below it, rendering itself per arm so a fork nests instead of flattening; an arm whose target is already placed comes back as a jump chip rather than recursing, which is what makes a cycle and a diamond both terminate |
| [`WorkflowFlowNode.svelte`](src/components/PipelineBuilderEditors/WorkflowFlowNode.svelte) | One node card — selection, and the reorder/remove buttons FR-042 keeps off a drag handle |
| [`WorkflowInspector.svelte`](src/components/PipelineBuilderEditors/WorkflowInspector.svelte) | The fields of whatever the canvas has in focus: Workflow identity, and a node's Pipeline binding and start-node checkbox |
| [`WorkflowBranchInspector.svelte`](src/components/PipelineBuilderEditors/WorkflowBranchInspector.svelte) | One branch — its endpoints and its condition, every meaning-bearing control a select over a closed set so FR-021 holds by construction |
| [`workflow-flow-layout.ts`](src/components/PipelineBuilderEditors/workflow-flow-layout.ts) | Pure layout — placement, arm order, and the `isJump` verdict that terminates the recursion; pinned by [`workflow-flow-layout.test.ts`](src/components/__tests__/workflow-flow-layout.test.ts) |
| [`WorkflowRowDefects.svelte`](src/components/PipelineBuilderEditors/WorkflowRowDefects.svelte) | Field-associated defect regions (`aria-describedby` → `role="alert"`) |
| [`workflow-catalog-state.ts`](src/components/PipelineBuilderEditors/workflow-catalog-state.ts) | Pure draft logic — every edit routes through `applyGraphEdit`, so no rule is expressible in markup |
| [`workflow-catalog-actions.ts`](src/components/PipelineBuilderEditors/workflow-catalog-actions.ts) | The two destructive writes, each with its confirmation in the same scope as the mutation it authorises |

Connections address a node by its stable `nodeId`, never by index — the inverse
of a Pipeline binding's `phaseIndex`, which must be remapped on every reorder.
A connection **condition** is structured data (`{ left, operator, right? }`)
compared field-wise against closed enums; there is no string form, parser,
evaluator, or sandbox, and there must never be one.

`webview-ui/src/lib/save-workflows.ts` was the **single call site** for
`CMD_SAVE_WORKFLOWS` — deleted by feature 101 with the rest of the whole-array
save path (see the feature 101 amendment above) — with the same UUIDv4
correlation, `snapshotStore.markPending`, one-shot ack listener, and 5-second
timeout as `save-pipelines.ts`. It does not reuse `save-catalog-command.ts`
because that helper discards `ack.result`, and a `stale-catalog` or
`workflow-validation` rejection carries the structured payload the Builder
needs to anchor a host defect to a field path. The request is forwarded
verbatim: authored node and connection order is part of the payload's meaning
(FR-049), so nothing client-side sorts, dedupes, or normalizes the graph.
[`../tests/lint/no-inline-save-catalog.test.ts`](../tests/lint/no-inline-save-catalog.test.ts)
fails the build if a component posts the command inline;
[`../tests/lint/destructive-actions.lint.test.ts`](../tests/lint/destructive-actions.lint.test.ts)
covers the `catalog.remove-workflow` and `catalog.reset-workflows` confirmations.

The UI stays pending after a save until a snapshot arrives whose
`revisions[scope]` differs from the one submitted, or a rejection is received —
waiting on the revision rather than the ack, since the ack only says the host
accepted the write. With an empty or wholly invalid effective Pipeline catalog
the editor explains the prerequisite and disables save rather than offering a
control that cannot succeed; a refreshed snapshot carrying a newly valid
Pipeline re-enables it without a reload.

### Process document exchange (specs 084 / 085 / 086)

The three catalog managers above can hand a definition to another installation as
a YAML document, and take one back. The Model Catalog (spec 096) joins the same
**Import…**/**Export** buttons and file dialogs with a structurally separate
shape rather than a fourth catalog-manager subsection of its own — see the
ownership table and "A fourth arm, structurally apart" below, and
[Model Catalog](../docs/operations/process-yaml.md#model-catalog) for the
operator-facing procedure. The webview owns the operator's decisions;
the host owns the file. **No filesystem path crosses this boundary in either
direction** — the webview names no path, receives none, and no plan row, payload,
or message may carry one. Export reports only whether a document was written, and
a write failure reports generically, because an adapter's own error text can name
the location it tried to write.

| File | Owns |
|---|---|
| [`process-yaml-ipc.ts`](src/lib/process-yaml-ipc.ts) | The **single call site** for the whole exchange family: `exportPhaseYaml`, `exportPipelineYaml`, `exportWorkflowYaml`, `exportModelCatalogYaml`, `preflightProcessYaml` |
| [`ProcessExportButton.svelte`](src/components/ProcessImport/ProcessExportButton.svelte) | The per-Phase Export control and its disabled reason |
| [`WorkflowToolbar.svelte`](src/components/PipelineBuilderEditors/WorkflowToolbar.svelte) | The Workflow Export control **and its three-mode inclusion list** |
| [`ModelCatalogEditor.svelte`](src/components/PipelineBuilderEditors/ModelCatalogEditor.svelte) | The Model Catalog's own Export control — unconditional, since a Model Catalog document always resolves, even an empty one (FR-007) |
| [`ProcessImportPreflight.svelte`](src/components/ProcessImport/ProcessImportPreflight.svelte) | The import flow shell and the ordered commit, branching to `runModelCatalogImportCommit` for a Model Catalog plan |
| [`ProcessImportPlanTable.svelte`](src/components/ProcessImport/ProcessImportPlanTable.svelte) / [`ProcessImportResultsTable.svelte`](src/components/ProcessImport/ProcessImportResultsTable.svelte) | Plan rows before the confirm, result rows after it — a Model Catalog row's fields (`backend`, `modelId`) replace the shared `resourceId`/`name` shape |
| [`process-import-state.ts`](src/components/ProcessImport/process-import-state.ts) | Pure projection — row labels, reason lines, `confirmBlockedReason`, `commitOutcome`, and the ordered-write sequencer; `modelCatalogImportRows`, `isModelCatalogPlan`, and `runModelCatalogImportCommit` are the Model Catalog's structurally separate, single-write counterparts |
| [`save-models.ts`](src/lib/save-models.ts) | `saveModelsImport` — the Model Catalog's own `CMD_SAVE_MODELS` call site for a confirmed import; kept apart from the pre-existing `saveModels` manual add/remove path rather than widening that function's signature |
| [`process-exchange-entry.ts`](src/components/ProcessImport/process-exchange-entry.ts) | The three preconditions a manager must decide before offering the controls |

**A fourth arm, structurally apart.** A Model Catalog plan never mixes with
Phase/Pipeline/Workflow rows in the same plan (FR-015), so it does not fit the
three-arm/three-vocabulary shape described next: there is no inclusion-depth
choice on export (`ModelCatalogEditor.svelte`'s button always produces the
whole catalog, every backend, as one document) and no ordered multi-layer
commit on import — a confirmed Model Catalog plan writes once, through
`saveModelsImport` (`save-models.ts`), never through the
`buildImportWrites`/`runImportCommit` sequencer the rest of this section
describes. See
[Model Catalog](../docs/operations/process-yaml.md#model-catalog) for the
operator-facing outcomes and skip reasons.

**Three export arms, three inclusion vocabularies.** A Phase has no dependencies,
so `exportPhaseYaml` takes an id and nothing else. A Pipeline has one level below
it, so its control is a checkbox — one level admits only two depths
(`references-only`, `include-referenced`). A Workflow has two levels, so its
control is a **list**, not a boolean: "the Pipelines" and "the Pipelines and their
Phases" are different answers and neither is the negation of the other
(`references-only`, `include-pipelines`, `include-closure`). The vocabularies are
declared per kind in `src/contracts/sidebar-ipc/process-yaml.ts` and both runtime
validators route through the single `admitsExportInclusion(resourceKind,
inclusion)` gate — one function rather than a copy per validator, because two
copies drift and a mode then compiles but is rejected at run time.

The inclusion choice lives in the toolbar's local state: it describes how *this
operator* is handing the definition over, not a property of the Workflow, so it
survives changing the selection rather than resetting under someone exporting
several rows in a row. Nothing is persisted, and the default is the smallest
document.

Only one export precondition is decided webview-side — an **unsaved draft**,
because export reads the catalog and a draft is not in it yet. Nothing else is
pre-checked: a stored Workflow whose Pipelines are missing from every layer is
still exportable with its graph intact, and whether a row resolves is the host's
decision, since only the host reads the effective catalog.

**Plan rows name the dependency's kind, and chain to the root cause.** A blocked
row reads its dependency's `kind` from the reason rather than assuming one — as of
086 a Pipeline waits on a Phase and a Workflow waits on a Pipeline, so a hard-coded
"Phase" would misname half the cases and send the operator to the wrong catalog.
When the dependency is *itself* blocked, the row renders two lines: what this row
waits on, and the chain through to what would unblock it. The chain is at most
three links and cannot be more (a Pipeline waits only on a Phase; a Phase waits on
nothing), so it is a complete trace rather than one hop of an open-ended walk.
Every identifier in those lines is the host's already-sanitized, already-bounded
value and is never re-bounded — a second cap would disagree with the first and
truncate an id the operator has to find in the catalog.

**The commit is up to three ordered writes, not one.** A package commits through
the existing `savePhases` → `savePipelines` → `saveWorkflows` helpers, in that
order, each carrying its own `expectedRevision` and its own single
`import-package` intent naming that layer's target set. The order is fixed by
dependency: a Pipeline's bindings are only satisfiable once its Phases are
effective, and a Workflow's nodes only resolve once its Pipelines are. Import adds
**no** mutating IPC command — it reuses the three catalog saves, so it inherits
their revision-before-trust ordering and their intent algebra unchanged.

The sequencer stops at the first non-accepted ack and **never compensates with a
delete**: whichever prefix landed stays written, and the outcome is reported as
`partial` rather than repaired. Re-running the same document is the recovery path
— the host's presence scan turns the already-written rows into `skip` rows, so the
retry is self-healing at whatever depth it stopped.

### New built-in pipeline: `speckit-bugfix` (spec 026)

The new-task pipeline selector, relocated by feature 097 to
[`QueueInputForm.svelte:128-146`](src/components/QueueInputForm.svelte)
(mounted in `drilldown/QueueDetailTier.svelte`'s on-demand composer; see
"Feature 017 queue and phase-task IPC" above), listed two built-in
pipelines (`speckit-new-feature`, `speckit-bugfix`) and defaulted to the
first. Feature 098 ships neither: the selector lists whatever
`availablePipelines` carries, which is empty until the operator imports a
document. `defaultSelectedPipelineId` preselects `defaultPipelineId` when it
names a Pipeline in the list and the first available one otherwise; `''` names
none, so an unset default preselects the first row rather than an id the
operator cannot see. There was a second, shortcut form in
`ControlPanel.svelte` that did NOT include the selector and fell back to the
controller's default pipeline (research Decision 6). FR-R3-140 deleted that
component as unreachable, so the selector-less path is gone with it and the
composer above is the only form that starts a task.

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

### IPC additions (spec 063 — Clean All + universal confirmations)

Feature 063 collapses the old "Clear completed" + "Clear failed" pair
into a single **Clean All** button and gates every destructive postCommand
site behind a universal confirmation prompt. Two new **mutating** IPC
commands:

- `CMD_CLEAR_ALL` — payload `{}`. Routes to `QueueManager.clearAll()` on
  the primary host, which performs an atomic reset of five surfaces in one
  state transaction: (1) every queue entry, (2) the active `WorkflowRun`,
  (3) the queue pause state, (4) any `ScheduleWatchdog` backoff window,
  (5) all watchdog-pending timers. Emits one `queue-cleared-all` audit
  event with the pre-clean counts. Replaces the legacy
  `CMD_CLEAR_COMPLETED` and `CMD_CLEAR_FAILED` commands (both removed).
- `CMD_SET_CONFIRM_SUPPRESSION` — payload `{ actionKey, suppressed }` where
  `actionKey` is one of the 11 destructive `ActionKey` members. Persists
  the per-action "Don't ask again" choice into webview-scoped settings.

Both commands are members of `MUTATING_COMMANDS` (primary-host gated).

Every destructive postCommand site flows through the shared confirmation
helper at
[`webview-ui/src/lib/use-confirm.ts`](src/lib/use-confirm.ts) —
`useConfirm(actionKey, options)` returns `Promise<boolean>`. The helper
short-circuits in three cases: (a) the global `schegent.ui.confirmations.enable`
setting is `false`, (b) the per-action suppression flag is set, (c) another
modal already owns the single-modal lock. Otherwise it imperatively
mounts the `ConfirmDialog` component and resolves on Confirm/Cancel.
Static copy for every `ActionKey` lives in
[`webview-ui/src/lib/action-copy.ts`](src/lib/action-copy.ts) (title, body
template, confirm label, danger flag); the Clean All entry alone
substitutes runtime context (`pendingCount`, `inflightTitle`, etc.) via
`renderActionBody`. The repo-grep regression at
[`../tests/lint/destructive-actions.lint.test.ts`](../tests/lint/destructive-actions.lint.test.ts)
fails the build on any destructive `postCommand(...)` call that is not
preceded by a matching `useConfirm(...)` await.

One new audit event type is additive (no `AUDIT_SCHEMA_VERSION` bump):
`queue-cleared-all { pendingCount, completedCount, failedCount, canceledCount, hadActiveRun, hadCascadePause }`.

### IPC additions (spec 064 — System tab and task-scoped Activity Feed)

Feature 064 adds **no new IPC commands** and **no new audit event types**.
It is a pure presentation-layer split powered by two additive fields on
each `AuditTailEntry`:

- `runId: string` — copied byte-for-byte from `AuditEntry.runId` by the
  projector. The Activity Feed uses it to gate visibility on the live-run
  reference set (`activeRunId ∪ queue.inFlight.id ∪ queue.pending[*].id
  ∪ queue.recent[*].id ∪ history[*].runId`).
- `scope: 'task' | 'system'` — produced by `classifyAuditEvent(eventType)`
  in [`../src/contracts/audit-events.ts`](../src/contracts/audit-events.ts).
  The closed `SYSTEM_SCOPED_EVENT_TYPES` set is the single source of
  truth; a TS `never` exhaustiveness assertion in
  [`../tests/unit/audit-events/event-classification.test.ts`](../tests/unit/audit-events/event-classification.test.ts)
  fails `tsc` if a new `AuditEventType` literal is added without being
  classified. Unknown event types default to `'task'` (FR-011), preserving
  the existing "Never drop unknown audit event types from the parser"
  invariant.

Both fields are added inside the existing frozen-object return of
[`projectAuditEntry`](../src/ui/sidebar/audit-tail-projector.ts). No
`AUDIT_SCHEMA_VERSION` bump (additive fields on a projected shape only),
no `STATE_SCHEMA_VERSION` bump. Legacy snapshots without `scope` are
treated as `'task'` per FR-013 (the AuditTail/SystemTab tests pin both
legacy-tolerance directions).

The `SystemTab.svelte` component is owned by Feature 064 and lives at
[`src/components/SystemTab.svelte`](src/components/SystemTab.svelte).
It is the dashboard's exclusive surface for system-scoped audit entries
and is **never** gated by runId reachability — `queue-cleared-all` and
other lifecycle/housekeeping events always render here (FR-015).

### IPC additions (spec 068 — Enhance System Log)

Feature 068 adds **no new IPC commands** and **no new audit event types**.
It extends `AuditTailEntry` with four optional fields populated by the
existing `projectAuditEntry`:

- `taskId?: string` — first-non-empty of `payload.taskId`,
  `payload.taskID`, `payload.queueItemId`.
- `phaseId?: string` — first-non-empty of `payload.phaseId`,
  `payload.phase`, envelope `entry.phase` (when not `'done'`).
- `outcome?: 'success' | 'error' | 'pending'` — normalized from the
  envelope `outcome` field; envelope `'failure'` → projected `'error'`.
- `command?: string` — populated only when `entry.eventType ===
  'cli-invocation'`; carries the spawned argv joined with spaces. The
  field flows through the existing audit-writer `logger.sanitizeRecord()`
  path before persistence (no new redaction).

All four are additive on the frozen projection (no `AUDIT_SCHEMA_VERSION`
bump). Legacy entries that lack any of these fields render with the
explicit-absence marker `—` per FR-009. The on-disk JSONL format is
unchanged; the only new payload field is `cli-invocation.command` and the
existing parser tolerates it.

The System tab also restores its tail on cold-start by reading
`.schegent/audit.log` once at snapshot bootstrap (see
[`../src/ui/sidebar/audit-tail-coldstart.ts`](../src/ui/sidebar/audit-tail-coldstart.ts)).
The filter is widened so `cli-invocation` entries cross-list in the
System tab regardless of `scope` (FR-011).

### IPC additions (spec 065 — Enqueue/Start separation)

Feature 065 separates enqueue from start. Tasks land in the queue
without auto-promotion; the operator (or a scheduled-start timer)
explicitly chooses when the queue begins draining. The webview owns
three new surfaces and one cross-component shared store:

**Components** (owned by feature 065):

- [`src/components/StartModeChooser.svelte`](src/components/StartModeChooser.svelte)
  — non-modal inline chooser surfaced when the operator triggers a Start
  on an `idle-pending` queue. Exposes "Start now" and "Start in
  HH:MM:SS" affordances. Emits an `onCommit(startIntent)` callback the
  parent translates into `CMD_START` or `CMD_START_QUEUE` with the
  optional `startIntent` payload. The chooser carries a
  `mode: 'idle-pending-restart' | 'empty-enqueue'` prop that selects
  whether the "Cancel schedule" affordance is available.
- [`src/components/ScheduledStartIndicator.svelte`](src/components/ScheduledStartIndicator.svelte)
  — countdown surface rendered when `queue.scheduledStartAt != null`.
  Renders 1-second cadence when expanded in the sidebar and the
  status-bar projection (`SchegentStatusBar.showTransient`) handles the
  3–5s transient indicator on schedule-fire per FR-017a / SC-009.
  Exposes Cancel, Change, and "Start now" actions that emit the same
  `startIntent` shape via the existing `CMD_START_QUEUE` channel.
- [`src/components/SystemTab.svelte`](src/components/SystemTab.svelte)
  audit filter set extended (additive) for `scheduled-start-*`,
  `idle-pending-*`, and `automation-enqueue-no-start-mode` event types.

**Shared store**:

- [`src/lib/tick-store.ts`](src/lib/tick-store.ts) — a single `setInterval`-
  backed Svelte store that fans out one timer tick per second to every
  visible `ScheduledStartIndicator`. Mounting N indicators consumes one
  timer (not N) per FR-017's per-renderer cost constraint. The store is
  reference-counted so it idles when no indicator is on screen.

**Helpers**:

- [`src/lib/start-mode.ts`](src/lib/start-mode.ts) — pure helpers that
  parse the chooser's `HH:MM:SS` input into a `scheduledStartAt`
  timestamp and validate the lockstep invariant (a `'later'` mode
  always carries a positive offset; a `'now'` mode never carries one).
- [`src/lib/remote-lifecycle-change-store.svelte.ts`](src/lib/remote-lifecycle-change-store.svelte.ts)
  — track multi-window queue-state churn so the chooser closes silently
  in the losing window during cross-window contention (Q13 / scenario 13).

**IPC shape (additive, no new commands beyond `CMD_DISMISS_MIGRATION_NOTICE`)**:

`CMD_START` and `CMD_START_QUEUE` accept an optional `startIntent`
field:

```ts
type StartIntent = {
  startMode: 'now' | 'later';
  scheduledStartAt?: number; // epoch ms, required when startMode === 'later'
  source:
    | 'operator-restart'
    | 'operator-chooser'
    | 'programmatic'
    | 'migration-default';
};
```

`startIntent` is optional for backwards compatibility (FR-024). A
command without a `startIntent` field is treated as `startMode: 'now'`
from the existing source attribution. The new `CMD_DISMISS_MIGRATION_NOTICE`
is the **only** new command type; it is deliberately excluded from
`MUTATING_COMMAND_TYPES` because the dismiss is non-destructive UX
state per FR-020.

No `AUDIT_SCHEMA_VERSION` bump (event types are additive within the
existing envelope). `STATE_SCHEMA_VERSION` is bumped to 7 by the
v6 → v7 migrator that introduces `queueLifecycle`, `scheduledStartAt`,
`scheduledStartSource`, and `migrationNotice` on the persisted queue
record. See
[`docs/operations/single-task-queue-migration.md`](../docs/operations/single-task-queue-migration.md)
for the migration walkthrough.

### IPC additions (spec 073 — Metrics dashboard)

Feature 073 adds a **read-only** rollup surface for the Dashboard's
Metrics tab, derived entirely from the existing `.schegent/audit.log`
(no new persistent storage):

- `CMD_READ_METRICS` — payload `{ includeArchived?: boolean }` (default
  `false`). Returns `{ tasks, phaseTypeAggregates, costTimeline,
  oldestIncludedTimestamp?, includesArchived, totalScannedEntries,
  parseWarnings }` inside the standard `CMD_ACK` envelope. There is no
  push-message counterpart — unlike the Phase Log Feed, Metrics has no
  live tail.

`CMD_READ_METRICS` is **read-only** and is NOT a member of
`MUTATING_COMMANDS` (mirrors the spec 020 phase-log commands above) —
a secondary VS Code host may dispatch it too. The single call site is
[`webview-ui/src/lib/metrics-ipc.ts`](src/lib/metrics-ipc.ts); a
repo-grep regression at
[`../tests/lint/no-inline-read-metrics-ipc.test.ts`](../tests/lint/no-inline-read-metrics-ipc.test.ts)
fails the build on any drift. No new snapshot envelope keys; no
`AUDIT_SCHEMA_VERSION` or `STATE_SCHEMA_VERSION` bump.

[`MetricsDashboard.svelte`](src/components/MetricsDashboard/MetricsDashboard.svelte) renders
the tab: summary cards, a sortable/paginated task table with
expandable per-phase detail, a phase-type analytics table, and an
inline-SVG cumulative daily-cost chart (no new charting dependency).
Under normal application-generated audit logs, `TaskRecord.description` is
always an internally-generated `taskId` or `runId` — never
operator-authored free text. Rendering safety does not depend on that
assumption holding, though: the table uses Svelte's default auto-escaping
with no `{@html}` usage anywhere in the component (FR-017), so a
hand-edited or adversarial log entry still can't inject markup.

### IPC additions (spec 101 — Builder surface)

One command, and it only reads.
[`src/lib/catalog-history-ipc.ts`](src/lib/catalog-history-ipc.ts) is the
**single call site** for `CMD_READ_DEFINITION_VERSION`, pinned by
[`../tests/lint/no-inline-catalog-history-ipc.test.ts`](../tests/lint/no-inline-catalog-history-ipc.test.ts).
`readDefinitionVersion({ kind, id, versionId })` correlates the request the same
way the lifecycle senders do — UUIDv4 id, one-shot ack listener, 5-second
timeout — and resolves to a closed result: `{ outcome: 'success', body }` or
`{ outcome: 'failure', reason }`, never a body and a reason together. The panel
that consumes it holds a three-state view (`pending | ready | error`), so a
failed read cannot render as an empty body.

The version *list* is not fetched: it rides the snapshot on each definition's
`lifecycle.versions`, and only the body an operator actually opens costs a round
trip. Reads carry no `expectedDraftVersion` — there is nothing to be stale
against — and a response arriving after the operator has opened a different
version is discarded rather than merged, which is a webview-side sequence check
rather than a cancellation the host knows about.

### Audit surfaces

The Dashboard exposes the audit tail through **one surface**, reading
`snapshot.auditTail`:

| Surface | Component | Visibility filter | Empty-state copy |
|---|---|---|---|
| **System tab** (peer route) | [`src/components/SystemTab.svelte`](src/components/SystemTab.svelte) | `entry.scope === 'system'` (no runId gate) | "No system events yet." |

There were **two complementary surfaces**. The second was an **Activity Feed**
under Operations, rendered by `AuditTail.svelte`, filtering
`entry.scope === 'task' && knownRunIds.has(entry.runId)` with the legacy
tolerance `scope ?? 'task'`, and telling an empty tail "No active task activity.
System events appear in the System tab." FR-R3-140 deleted it: no route or panel
imported it, only its own tests did, so the operator had no way to reach the
feed the empty-state copy was pointing away from. Nothing replaced it — the
task-scoped half of the split is currently unrendered. `PhaseLogFeed.svelte`
also reads `snapshot.auditTail`, but only to recover which runner started a
phase; it is not an audit surface.

The surface orders entries newest-first. The on-disk
`.schegent/audit.log` is untouched — the split is purely the webview's
read-side classification of an existing append-only log. The
disk-integrity regression at
[`../tests/integration/clean-all-disk-integrity.test.ts`](../tests/integration/clean-all-disk-integrity.test.ts)
hashes the log before/after a Clean All cycle and asserts the prefix is
byte-identical (SC-005). The `AUDIT_TAIL_MAX = 50` ring-buffer cap is
unchanged (FR-012).

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
