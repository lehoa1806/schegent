# Schegent Dashboard UI/UX Guide

The Schegent Dashboard is a rich Webview that serves as the central control plane for the autonomous workflow. While the sidebar is optimized for passive monitoring, the Dashboard is optimized for active management, queue inspection, and deep audit log review.

## Visual Anatomy

```text
+-------------------------------------------------------------------------+
| SCHEGENT DASHBOARD                                                      |
+-------------------------------------------------------------------------+
| [ Queue Input Section ]                                                 |
| ╭─────────────────────────────────────────────────────────╮ ╭────────╮  |
| │ Describe the feature or bugfix you want to build...     │ │ Submit │  |
| ╰─────────────────────────────────────────────────────────╯ ╰────────╯  |
|                                                                         |
| [ Queue Management Controls ]                                           |
|  [ ▶ Resume Queue ]  [ ⏸ Pause Queue ]  [ 🧹 Clear Done ]  [ 🗑 Clean All ] |
|                                                                         |
| [ Active & Pending Queue ]                                              |
|  1. [ in-flight ] 005-stabilization-refactor               [ Cancel ]   |
|  2. [ pending   ] 006-telemetry-metrics                    [▲] [▼] [✖]  |
|  3. [ failed    ] 004-sha256-precheck                      [ ↻ Retry ]  |
|                                                                         |
| [ Phase Progression (Active: 005-stabilization-refactor) ]              |
|  [ specify ] ➔ [ clarify ] ➔ [ plan ] ➔ [ tasks ] ➔ [ analyze ]         |
|                               ➔ [ IMPLEMENT ⏳ ] ➔ [ finalize ]         |
|                                                                         |
| [ Phase Log Feed — Queue ▾  Task ▾  Phase ▾  Iter ▾   [LIVE] [↪current] ]|
|  12:45:01 [tool-use]      Bash: npm run test:integration                |
|  12:44:12 [assistant]     Running the integration suite to verify…     |
|  12:43:50 [tool-result]   3 of 4 tests passing; one shape mismatch     |
+-------------------------------------------------------------------------+
```

## Section Breakdown & Responsibilities

### 1. Queue Input Section
**Purpose:** The entry point for dispatching new features or bugfixes to the Schegent autonomous pipeline.
- **Input Field:** A text area where you provide the natural language description of the feature, bug, or task.
- **Submit Button:** Enqueues the request. If the queue is empty and unpaused, the workflow begins immediately.

### 2. Queue Management Controls
**Purpose:** Global controls for the queue execution state and cleanup.
- **Pause/Resume Queue:** Temporarily stops the auto-drain mechanism. In-flight items will finish their current phase, but the next pending item will not start until resumed.
- **Pause Phase (sidebar / dashboard, feature 033):** When an operator clicks **Pause** on the active phase, the Claude CLI subprocess receives SIGTERM **at click time** rather than at the next phase boundary. If the subprocess does not exit within the runner's built-in grace window (`SIGKILL_DELAY_MS = 2000` ms) the runner escalates to SIGKILL. The visible effect is a wedged run terminates within ~2 seconds of the click. The cascade-pause invariant is preserved: pausing a phase also cascade-pauses its host queue (`pauseSource: 'cascade'`); a queue that was previously operator-paused (`pauseSource: 'operator'`) stays operator-paused after the phase resumes (operator wins; `cascadedResume` is a NO-OP in that case). Resume continues the prior Claude conversation via the `-c` flag — `isContinue: true` flows through both the spawned argv and the `phase-start` audit event in lock-step (032 invariant preserved).
- **Clear Done:** Removes `completed` items from the recent queue (fires `CMD_CLEAR_COMPLETED` after operator confirmation). Disabled when no completed items exist.
- **Clean All (feature 063):** A single atomic reset of five surfaces — every queue entry (pending, in-flight, recent including `cancelled`), the active workflow run (if any) including any in-flight controller, the queue pause state (operator or cascade), any `ScheduleWatchdog` backoff window, and all watchdog-pending timers. Replaces the legacy compound `Clean` button (`CMD_CLEAR_COMPLETED` + `CMD_CLEAR_FAILED`) which left the operator without a way to reset an in-flight run or a paused queue. Fires `CMD_CLEAR_ALL` after operator confirmation. Disabled only when **all** five surfaces are already empty (no pending, no in-flight, no recent, not paused, no active run, no watchdog backoff). The confirmation dialog body lists the exact impact (counts per status, the in-flight task title if any, the pause source, and whether an active run will be terminated) so the operator can decide with full context.
- **Universal confirmation prompts (feature 063):** Every destructive control on the Dashboard — Pause, Resume, Clear Done, Clean All, Cancel, Remove, Retry-Now, Restart, Modify, Re-run from history, Reset Workspace — routes through the same `useConfirm(actionKey)` dialog. The dialog severity and copy come from a single table; the prompt offers a per-action "Don't ask again" checkbox that persists across webview reloads (workspace-scoped). Suppression survives normal use but is wiped atomically by **Reset Workspace** alongside every other workspace-state key, so the operator always sees fresh prompts after a workspace reset. The lone exception is **Reset Workspace** itself, which is always unsuppressible. A workspace-level setting `schegent.ui.confirmations.enable` disables all prompts globally; flip it off only for power-user automation contexts.

### 3. Active & Pending Queue List
**Purpose:** Displays the ordered list of all tasks. The queue manager executes items strictly top-to-bottom.
- **Status Badges:** Clearly marks each item (`in-flight`, `pending`, `failed`, `completed`, `cancelled`).
- **Feature Name / Description:** The title of the task.
- **Item Controls (per-status, exhaustive):**
  - `in-flight` row: `[ Cancel ]` — aborts the active workflow run (dispatches `CMD_CANCEL`).
  - `pending` row: `[▲] [▼] [✖]` — reorder up/down (`CMD_MOVE_QUEUE_ITEM_UP/DOWN`); the `✖` glyph removes the item from the queue (`CMD_REMOVE_QUEUE_ITEM`), not workflow cancellation. `[▲] [▼]` are hidden when fewer than two pending items exist.
  - `failed` row: `[ ↻ Retry ]` — re-enqueues the task (`CMD_RETRY_QUEUE_ITEM`).
  - `completed` and `cancelled` rows: no per-row buttons. Terminal-row cleanup is delegated to the global `Clear Done` and `Clean` controls in the Queue Management zone.

### 4. Phase Progression Tiles
**Purpose:** Visually tracks the state machine's progression across the Spec Driven Development workflow pipeline for the *currently active* feature.
- **Tiles (`specify` -> `finalize`):** Each tile represents a distinct pipeline phase. 
- **UX Responsibility:** The active phase is highlighted (e.g., `IMPLEMENT ⏳`), giving you immediate context on whether the system is writing specs, planning architecture, or emitting code.

### 5. Phase Log Feed (spec 020 — replaces the audit-tailed Activity Feed)

**Purpose:** A real-time, human-readable projection of the underlying
per-phase `stream.jsonl` files written by the Claude CLI when verbose
diagnostics are enabled. The previous audit-log-tailed Activity Feed
that ran off `.schegent/audit.log` is replaced by this richer
per-phase drill-in.

**Selection model (cascade):** Queue → Task → Phase → Iteration.

- **Queue selector** — populated from `snapshot.queue.queues`; defaults to
  the queue owning the active run when present, otherwise the first
  non-empty queue.
- **Task selector** — populated from the queue's tasks (in-flight,
  pending, recent, and history). Defaults to the in-flight task when the
  selected queue has one.
- **Phase selector** — populated from the task's pipeline catalog
  (`WorkflowRun.pipeline.phases`); defaults to the currently executing
  phase, or the most recently completed one for terminal tasks.
- **Iteration selector** — populated by listing the
  `.schegent/sessions/<runId>/diagnostics/<pipelineId>/<phaseId>/iter-*`
  directories. Ordering is **most-recent-first** (descending). Defaults to
  the most recent iteration.

**Live tailing:**

- When the selected (Queue, Task, Phase, Iteration) corresponds to an
  in-flight phase and the operator has it open, the host opens a
  `fs.watch` (or polling fallback) session and streams new entries via
  `MSG_PHASE_LOG_ENTRY` pushes.
- The **LIVE** badge in the feed header is visible while a tail session
  is bound. It turns off on three teardown triggers: webview stop (user
  navigated away or stopped manually), webview dispose (panel closed),
  or phase completion (the phase that owns the stream transitions to a
  terminal state). All three emit a synthetic `tail-ended` push so the
  webview can clear the badge deterministically.
- A **"Jump to current phase"** affordance shortcuts the four selectors
  to the in-flight (Queue, Task, Phase, latest Iteration) tuple. It is
  visible only when an in-flight phase exists and the current selection
  is not already pointed at it.
- The tail registry enforces a **cap of 1** — opening a new selection
  silently tears down any existing session.

**Display:**

- Each entry renders with a short timestamp / monotonic seq, a kind
  badge (`assistant-text`, `tool-use`, `tool-result`, `system`, `error`,
  `result`), and a body block.
- Body fields are truncated at the IPC boundary to **4096 UTF-8 bytes
  per field**, with a `Truncated · original N bytes` chip when the cap
  fired.
- Redaction is applied via the central `SECRET_PATTERNS` set in
  [`src/lib/logger.ts`](../../src/lib/logger.ts) — the same source of
  truth used by the OUTPUT channel, audit log writer, and runtime log
  sink. Adding a new pattern there extends every consumer
  automatically.
- Raw framing kinds (`message_start`, `message_delta`,
  `message_stop`, `content_block_*`) are dropped during projection;
  only operator-meaningful kinds are surfaced.

**Empty-state and error guidance:**

- **No verbose diagnostics enabled** → empty-state card pointing to the
  `schegent.logging.verbose` setting with a "How to enable" callout.
- **Missing iteration directory** → "No log for this iteration yet"
  with a refresh affordance.
- **Malformed JSONL lines** → silently skipped during projection and
  surfaced as a `Skipped N malformed line(s)` chip at the bottom of
  the feed.

**Disk bytes are never altered.** The `stream.jsonl` files on disk
remain the unredacted, untruncated, operator-opt-in local sink (per
the 010 verbose diagnostics invariant). Sanitization is applied only
on the IPC path that crosses into the webview.

**Human-readable render (spec 029):** Each `PhaseLogDisplayEntry` is
projected into one of four visual block types at render time. These
projections are pure functions of the sanitized IPC payload — never
written back to disk, never round-tripped through a second sanitizer.

- **Tool-call card** (`kind: 'tool-use'`) — A card with the tool name
  as a header and each top-level argument as a labeled `key: value`
  row. Scalar values render inline; multi-line strings render in a
  scrollable `<pre><code>` block; arrays render as bulleted lists with
  a `+K more` overflow affordance at 50 items; plain objects render
  one level deep. Truncated arguments surface a
  `truncated · original N bytes` pill at the card footer.
- **Multi-line code block** — A horizontal-scrolling, vertically
  capped `<pre><code>` element with a "Copy" button. The Copy button
  uses `navigator.clipboard.writeText(text)` on supported hosts and
  falls back to a hidden-textarea selection on legacy ones. The copy
  payload is the **sanitized** rendered text — secrets matching
  `SECRET_PATTERNS` are replaced with the redaction placeholder
  before they ever reach the clipboard.
- **Metadata strip** — A collapsible row at the top of the reading
  pane that consolidates the latest values of `cwd`, `session_id`,
  `duration_ms`, `cost`, `tools`, `model`, and `num_turns` detected
  inside `system` / `result` summary lines. The strip is sticky and
  does not affect the existing auto-tail-at-bottom heuristic. Latest
  value wins on duplicates.
- **Audit completion card** — When an `assistant-text` body contains
  `=== SCHEGENT AUDIT LOG === … === END SCHEGENT AUDIT LOG ===`, the
  surrounding entry splits into three sub-regions: prefix text →
  status card → suffix text. The card status badge is `CLEAR` (green),
  `FAILED` (red), or `UNKNOWN` (amber) based on the
  `[SCHEGENT_STATUS: …]` token inside the block. The full footer
  body renders inside a `MultiLineCodeBlock`.

**Copy-fidelity guarantee:** The Copy button on a multi-line block
emits the exact bytes the operator sees — which are the
already-sanitized bytes from the IPC payload. Operators can paste
into a scratch file and diff against the agent's intended output.

**Immutability spot-check (operator):**

```bash
shasum -a 256 /path/to/.schegent/sessions/.../iter-N/stream.jsonl
# … open + interact with the Activity Feed for that iteration …
shasum -a 256 /path/to/.schegent/sessions/.../iter-N/stream.jsonl
```

The two hashes must match. The regression test
[tests/integration/phase-log-on-disk-immutability.test.ts](../../tests/integration/phase-log-on-disk-immutability.test.ts)
asserts this property on every CI run.

### 6. System tab (spec 064 + 068)

The Dashboard's **System** tab renders system-scoped audit events
(`queue-cleared-all`, `queue-paused`, scheduled-start transitions, etc.)
plus `cli-invocation` entries cross-listed from the live tail. Each
entry now shows an absolute timestamp, the originating `taskId` and
`phaseId` (or `—` when absent), a category badge, an outcome badge with
a colored left-border, the full (untruncated) summary, and — for
`cli-invocation` events — the sanitized CLI command in a monospace,
whitespace-preserving `<pre>` block.

**Persistence across reload (spec 068, US3):** on webview cold-start the
host reads the tail of `.schegent/audit.log` (bounded by
`AUDIT_TAIL_MAX = 50`) and seeds the first snapshot so the System tab is
non-empty before any live event arrives. Missing or unreadable audit
files degrade silently to an empty list — no operator-facing modal.

---

**Related Documentation:**
- [Sidebar UI/UX Guide](sidebar-ui.md) - For the passive, high-density view.
- [Schedule Multiple Features](schedule-multiple.md) - Deep dive into auto-drain and queue mechanics.
- [Inspect Audit Logs](inspect-audit-logs.md) - How to query the underlying `.schegent/audit.log` data.

---

**Last reconciled with implementation: 2026-05-15 (post-spec 029 human-readable activity logs)**

The five sections above map 1:1 to spec.md FR-033..FR-038 (Queue Input → Queue Management → Active & Pending Queue → Phase Progression → Phase Log Feed) and are enforced at the unit level by `webview-ui/src/components/__tests__/Dashboard.test.ts` (data-testids: `dashboard-queue-input`, `dashboard-queue-management`, `dashboard-queue-list`, `dashboard-phase-progression`, `dashboard-phase-log-feed`) and at the bundle level by `tests/integration/dashboard-activation.host.test.ts`. There is no separate Monitor pane — monitor events surface in the Live Activity overlay of the Phase Log Feed; the underlying audit log remains the canonical sanitized record and is queryable per [Inspect Audit Logs](inspect-audit-logs.md).
