# Single Task Queue Migration (v5 → v6)

Feature 030 collapses Schegent's multi-queue task model into a single, unified, sequentially-executed queue. This operations note covers what happens on activation, what to expect in the audit log, how to verify the unified queue, and the (un)supported recovery paths.

## What v6 changes

| Surface | v5 (multi-queue) | v6 (unified queue) |
|---|---|---|
| `QueueRegistry.entries` | 1..20 named queues; per-queue settings + schedules | Exactly one entry with `id === 'default'`, `position === 0`, `schedule === null` |
| `MAX_QUEUES` | `20` | `1` |
| Queue rename / delete / create | Available via IPC + UI | Removed; the seven legacy commands (`CMD_CREATE_QUEUE`, `CMD_RENAME_QUEUE`, `CMD_DELETE_QUEUE`, `CMD_SET_QUEUE_SCHEDULE`, `CMD_CLEAR_QUEUE_SCHEDULE`, `CMD_SAVE_QUEUE_SETTINGS`, `CMD_MOVE_TASK`) are deleted |
| Reorder | Move-up / move-down arrows | Drag-and-drop **or** move-up / move-down arrows; new `task-reordered` audit event |
| `WorkflowRun.queueId` | Per-queue id | Always `'default'` |
| Queue-level pause | Per-queue `state === 'manually-paused'` | Single unified pause; inherits paused state if **any** v5 source queue was paused |

The migrator is **forward-only**. There is no `v6 → v5` path; downgrade is unsupported.

## What happens on activation

On extension activation, [src/state/workspace-state.ts](../../src/state/workspace-state.ts) runs the v5 → v6 migrator before snapshot construction or watchdog start. The migrator at [src/state/queue-state-migrator.ts](../../src/state/queue-state-migrator.ts) `migrateV5ToV6()`:

1. Identifies the in-flight run (if any) and preserves its `WorkflowRun` state exactly (`pipeline` snapshot, `manualPauseCause`, `phaseBreakpoints`, `phaseOverrides`, `pendingRetryAt`/`pendingRetryCause` pair).
2. Coalesces pending runs across all v5 source queues into a single ordered list. Within-queue position order is preserved, and source queues are sequenced by `createdAt` ascending.
3. Reassigns `queuePosition` densely starting at `0` (in-flight first, then pending).
4. Rewrites every run's `queueId` to `'default'`.
5. Constructs the single `QueueRegistryEntry`:
   - `id: 'default'`
   - `name: 'Default queue'`
   - `position: 0`
   - `schedule: null`
   - `state: 'manually-paused'` **if any** source queue was paused; else `'active'`
   - `pauseSource: 'operator'` when inherited paused, else `null` (preserves the 028 cascade invariant)
   - `createdAt: min(source createdAt)` (earliest source preserved)
6. Bumps `schemaVersion` to `6`.
7. Emits a `state-migrated` audit event (see below).

The migrator is **idempotent**: a second activation on a v6 state is a no-op and emits no audit event.

## What the audit log shows

A successful migration writes a single `state-migrated` entry to `.schegent/audit.log`:

```json
{
  "eventType": "state-migrated",
  "timestamp": "...",
  "outcome": "success",
  "payload": {
    "fromVersion": 5,
    "toVersion": 6,
    "sourceQueueCount": 3,
    "pendingTaskCount": 4,
    "inFlightTaskCount": 1,
    "inheritedPausedState": true,
    "coalesceRule": "createdAt-ascending"
  }
}
```

A fresh workspace (no prior v5 state) emits **no** `state-migrated` event — there is nothing to migrate.

Historical entries in `.schegent/audit.log` from before the migration (e.g., `queue-created`, `queue-renamed`, `queue-deleted`, `queue-schedule-set`) are **not** rewritten. Per FR-016 and the existing "never drop unknown audit event types" hard rule, the audit parser preserves these legacy event types when re-reading the log; the producing code paths no longer exist in v6.

The new `task-reordered` audit event (FR-019) is emitted on every reorder request — success and rejection alike:

```json
{
  "eventType": "task-reordered",
  "outcome": "success" | "rejected",
  "payload": {
    "queueId": "default",
    "taskId": "...",
    "fromPosition": 3,
    "toPosition": 0,
    "source": "drag" | "arrow",
    "cause": "secondary-host" | "task-not-pending" | "invalid-position" | "no-op"
  }
}
```

## How to verify the unified queue

1. **Open the workspace** in VS Code with the new build.
2. **Inspect the activation log**: open the **Output** channel → **Schegent**. A `state-migrated` log entry with `fromVersion: 5, toVersion: 6` confirms the migration ran. The coalesce summary (`sourceQueueCount`, `pendingTaskCount`, `inFlightTaskCount`, `inheritedPausedState`) lets you reconcile against the v5 snapshot.
3. **Inspect the audit log**:

   ```bash
   grep '"eventType":"state-migrated"' .schegent/audit.log | tail -n 1 | jq -c .
   ```

4. **Open the sidebar**: exactly one queue list is visible. There is no Queue tab, no queue switcher, no queue rename / delete / create controls, and no numeric "set task position" input.
5. **Verify pending order**: the pending list should match the migrator's coalesce rule — the earliest source queue (by `createdAt`) first, preserving its within-queue order, then the next source queue, and so on.
6. **Verify paused state**: if any source queue was `manually-paused`, the unified queue is `manually-paused`. The pause cause renders as operator-initiated. Press **Resume** to clear it.
7. **Verify reorder**: drag a pending task to a new position **or** click an up/down arrow on a pending row. Confirm the visual order updates promptly and a `task-reordered` audit event is written.

## v6 → v7 (Feature 065 — Enqueue/Start Separation)

Feature 065 introduces the **lifecycle discriminator** (`queueLifecycle`) and **scheduled-start** state. The v6 → v7 migrator at [src/state/queue-state-migrator.ts](../../src/state/queue-state-migrator.ts) `migrateV6ToV7IfNeeded()` is forward-only and idempotent (keyed on the presence of `queueLifecycle`).

### What v7 adds

| Field | Meaning |
|---|---|
| `queueLifecycle: 'running' \| 'operator-paused' \| 'idle-pending' \| 'active-empty'` | The single, persisted lifecycle discriminator. The legacy `paused: boolean` field is preserved alongside as a derived projection. |
| `scheduledStartAt: number \| null` | Epoch-ms timestamp for the next armed start. `null` when no schedule is armed. Lockstep invariant: non-null **only** when `queueLifecycle === 'idle-pending'`. |
| `scheduledStartSource: ScheduledStartSource \| null` | Audit attribution for the armed schedule. `'migration-default'` is the source assigned by the v6 → v7 migrator. |
| `migrationNotice: 'pending' \| 'dismissed' \| undefined` | One-time operator notice flag (FR-020). Set to `'pending'` by the migrator when at least one queue migrated into `idle-pending`. Cleared to `'dismissed'` by an operator dismiss; never re-armed. |

### Derivation table (idempotent)

Given a v6 `(inFlight, paused, pending)` tuple, the migrator assigns `queueLifecycle` per the lookup at `queue-state-migrator.ts:130`:

| `inFlight` | `paused` | `pending.length > 0` | → `queueLifecycle` |
|---|---|---|---|
| non-null | * | * | `'running'` |
| null | `true` | * | `'operator-paused'` |
| null | `false` | `true` | `'idle-pending'` |
| null | `false` | `false` | `'active-empty'` |

When the result is `'idle-pending'`, the migrator additionally writes `scheduledStartSource: 'migration-default'` and `migrationNotice: 'pending'` on the queue. The actual `scheduledStartAt` remains `null` — the operator must explicitly arm a schedule via the chooser or accept the immediate-start affordance.

### Operator-facing changes

- **Lifecycle indicator**: the sidebar queue header surfaces a colored dot + short label ("Running", "Paused", "Idle (pending)", "Active (empty)") so the lifecycle is visible at a glance.
- **Start Queue button**: when the queue is `idle-pending` with no armed schedule, the "Start queue" button replaces the legacy auto-start affordance. The button opens a non-modal chooser with "Start now" and "Start in…" options.
- **Migration notice**: a non-modal, dismissible banner appears on the first workspace open after migration, explaining that pending tasks were preserved and pointing to the "Start queue" affordance. Dismissing the banner persists `migrationNotice: 'dismissed'` and is final.
- **Scheduled start countdown**: when a schedule is armed, the sidebar shows a countdown (expanded: 1s cadence; collapsed in status bar: 1m cadence) with Cancel, Change, and Start now actions.

### What the audit log shows

The v6 → v7 migrator emits a single `state-migrated` entry on success:

```json
{
  "eventType": "state-migrated",
  "outcome": "success",
  "payload": {
    "fromVersion": 6,
    "toVersion": 7,
    "queueLifecycleAssigned": "idle-pending",
    "migrationNoticeArmed": true
  }
}
```

In addition, feature 065 introduces a new family of audit events the System tab can filter on:

- `scheduled-start-armed`, `scheduled-start-changed`, `scheduled-start-cancelled`, `scheduled-start-fired`, `scheduled-start-superseded` (lifecycle transitions for the in-process timer)
- `idle-pending-promoted`, `idle-pending-auto-started` (transitions out of `idle-pending`)
- `automation-enqueue-no-start-mode` (wake-up / programmatic enqueue without an explicit start mode)

All payloads carry the consistent core `{ queueId, eventType, occurredAt, transitionReason }` per FR-023a. Task descriptions and operator-authored content are **not** included.

### What does NOT change

- `AUDIT_SCHEMA_VERSION` remains `2` — feature 065 adds new event types but does not change the envelope shape (additive).
- `MAX_QUEUES` remains `1`.
- The legacy `QueueState.paused` boolean is preserved alongside `queueLifecycle` for forward-compatibility with code paths that have not yet migrated to the discriminator.
- Pending task ordering and `WorkflowRun` shapes are preserved byte-for-byte (SC-005).

### Downgrade is unsupported

As with v5 → v6, there is no `v7 → v6` path. The same recovery procedure applies: export pending work via the audit log, run **Schegent: Reset Workspace State**, and re-install the earlier build.

## Sanity-check the queue registry shape

If you want to confirm the workspace-state shape directly (e.g., for debugging), the registry exposed via the snapshot has:

- `entries.length === 1`
- `entries[0].id === 'default'`
- `entries[0].position === 0`
- `entries[0].schedule === null`
- `entries[0].pauseSource === null` whenever `entries[0].state !== 'manually-paused'` (the 028 invariant is preserved by v6 as well)

The v6 validator at [src/queue/queue-registry.ts](../../src/queue/queue-registry.ts) `validateQueueRegistry()` rejects any other shape.

## Downgrade is unsupported

There is no `v6 → v5` migrator. If you need to roll back to a pre-030 build for any reason:

1. Save / export any pending work via the existing audit log (e.g., copy `description` payloads from `workflow.started` entries).
2. Run **Schegent: Reset Workspace State** (`schegent.reset`) to clear the v6 state — see [reset-safely.md](reset-safely.md).
3. Re-install the pre-030 extension build. The earlier build will see no Schegent state and initialize a fresh v5 registry.

Audit log archives in `.schegent/audit.log.<stamp>` remain readable across builds — the audit parser preserves unknown event types per the "never drop unknown audit event types" hard rule.

## Troubleshooting

| Symptom | Likely cause | Action |
|---|---|---|
| Sidebar still shows a Queue tab after upgrading | Webview cache stale | Run **Developer: Reload Window**. If still present, the build is pre-030. |
| `state-migrated` event missing on a workspace that had v5 state | Migration ran but the audit writer flushed after a crash | Confirm `schemaVersion === 6` via the snapshot; the audit gap is benign — the migrator is idempotent and the next activation will not re-emit. |
| Pending task order does not match the v5 layout | Coalesce ordering is `createdAt` ascending across source queues, then within-queue position ascending | Verify v5 `createdAt` values via an archived `.schegent/audit.log.<stamp>` — the order should match. |
| Unified queue starts paused on a fresh upgrade | One or more v5 source queues had `state === 'manually-paused'` | Press **Resume** in the sidebar. The unified queue's `pauseSource` is `'operator'`. |
| Reorder rejected with `cause: 'task-not-pending'` | The targeted task became in-flight before the reorder was processed | Refresh and retry on the next pending task. |
| Reorder rejected with `cause: 'secondary-host'` | A second VS Code window held the primary-host gate | Close the secondary window; the primary will accept the reorder. |

## Where to look next

- [recover-after-restart.md](recover-after-restart.md) — how v6 state is rehydrated on activation.
- [reset-safely.md](reset-safely.md) — when you need to clear v6 state entirely.
- [inspect-audit-logs.md](inspect-audit-logs.md) — `state-migrated` and `task-reordered` event reference.
- [sidebar-ui.md](sidebar-ui.md) — operator surfaces on the unified queue.
