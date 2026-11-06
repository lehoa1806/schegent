# Webview snapshot cost, render cost and persisted-state growth

**Opened**: 2026-10-31 · **Item**: `FR-R4-F08` (bounded and keyboard-accessible webview)

This page records what the state snapshot costs the extension host and the webview, how many
snapshots a hidden sidebar is sent, and how the persisted records grow. Each change to the snapshot
that those figures could justify (per-slice revisions, raw reactive state, list virtualization) is
decided against a threshold that is written first, below, and is not edited afterwards. Every figure
carries the date and the environment that produced it; an observation that needs another environment
is listed as pending qualification and is never marked passed.

<!-- Source: tests/perf/webview-snapshot-cost.test.ts -->
<!-- Source: tests/visual/snapshot-render-cost.visual.spec.ts -->
<!-- Source: tests/perf/persisted-state-growth.test.ts -->
<!-- Source: tests/visual/actual-policy.visual.spec.ts -->
<!-- Source: src/ui/sidebar/csp.ts -->
<!-- Source: src/contracts/snapshot-bounds.ts -->
<!-- Source: src/ui/sidebar/snapshot-transport.ts -->

## 1. The adoption threshold

Declared on 2026-10-31, before any figure on this page was recorded. Each threshold is a p95 over at
least 200 samples after 20 warm-up samples, on the named fixture.

| Change | Adopted only if | Why this number |
|---|---|---|
| Per-slice revisions (an IPC shape change) | host cost per flush (project plus `JSON.stringify`) ≥ 8 ms, **or** serialized snapshot ≥ 512 KiB, on the active or large-history fixture | An active Run flushes at up to about 10 per second (100 ms debounce, 500 ms deadline). 8 ms per flush is then up to 8% of the extension host's one thread, and 512 KiB at the 2-per-second deadline cadence is about 1 MiB/s of structured clone |
| Raw (non-deep) reactive snapshot state | webview apply-to-next-frame ≥ 16 ms on the active or large-history fixture | One frame at 60 Hz. Above it, every snapshot drops a frame while the operator is reading |
| List virtualization (History) | the large-history fixture's apply-to-next-frame ≥ 16 ms **and** its median at twice the history ≥ 1.8 times the median at the base size | Virtualization helps only if the cost is driven by rendered rows. The doubling test separates row cost from fixed cost |

## 2. Figures

**Measured**: 2026-10-31, on `repo/` branch `255-bounded-accessible-webview` at `80c16667` plus this
feature's working tree. **Environment**: macOS 27.0.1, Apple M1 Pro (darwin/arm64, 10 cores), Node
v24.19.0; browser figures in Chromium 151.0.7922.34 under Playwright 1.62.1. Each run was taken alone, with
the load average read first (2.2 to 2.8). Every distribution is 200 samples after 20 warm-up samples.

**The four workloads.**

| Workload | What it holds |
|---|---|
| idle | one empty default queue, no Run, no history |
| active | one executing Run with five Phases, an audit tail of 50 and a debug tail of 200 |
| large-history | the active workload on 20 queues, with 2,000 history entries: each of 20 live queues' partitions and 20 deleted queues' partitions filled to the history cap |
| large-history-2x | the same with 60 deleted partitions, 4,000 entries (history is capped per partition, so more entries means more partitions) |

**Host: one state projection and its serialization** (real `WorkspaceStateStore` over an in-memory
memento, real `HistoryStore`, real `StateProjector`). p95 in milliseconds.

| Workload | Serialized snapshot | `project()` p95 | `JSON.stringify` p95 | Sum of the two p95s |
|---|---|---|---|---|
| idle | 5,738 B | 0.025 | 0.009 | 0.034 |
| active | 37,734 B | 0.036 | 0.062 | 0.098 |
| large-history | 780,306 B (762 KiB) | 1.558 | 0.813 | 2.371 |
| large-history-2x | 1,516,706 B (1.45 MiB) | 2.446 | 1.578 | 4.024 |

The sum of two p95s is at least the p95 of the sum, so the last column is an upper bound on the cost
per flush as the threshold defines it.

**Webview: dispatch of a snapshot to the second animation frame after it** (the built dashboard on the
History route, Chromium). Milliseconds.

| Workload | Payload | History rows shown | p50 | p95 | max |
|---|---|---|---|---|---|
| idle | 9,150 B | 0 of 0 | 13.5 | 14.6 | 15.5 |
| active | 51,675 B | 1 of 1 | 13.3 | 14.4 | 15.9 |
| large-history | 830,344 B | 200 of 2,001 | 7.2 | 9.5 | 16.2 |
| large-history-2x | 1,606,744 B | 200 of 4,001 | 10.7 | 16.6 | 19.9 |

The render payloads are larger than the host's projections because they carry the base fixture's
catalogs, settings and backend postures, which the host workloads (no catalog configured) do not.
The History route renders at most 200 rows however many entries the snapshot holds, so the large
workloads measure the cost of applying a larger payload, not of drawing more rows.

**What this metric can and cannot say.** The time to the second animation frame includes waiting for
frames. The idle workload, which has nothing to draw, reads 13.5 ms at p50 and 14.6 ms at p95, so about
14 ms is the metric's floor in this browser, and the large-history p50 (7.2 ms) is below it. The figures
near 16 ms are therefore close to the frame cadence and are not, on their own, evidence of render cost.
The decisions below apply the threshold as it was written; this paragraph states how far the
measurement reaches.

**Hidden sidebar** (60 simulated seconds of the active workload's 1 Hz tick, with the view hidden, then
one reveal):

| Run | Snapshots delivered while hidden | Posted while hidden | Bytes posted while hidden | Posted by the reveal |
|---|---|---|---|---|
| before the provider gated on visibility | 54 | 54 | 2,039,994 | 0 |
| after | 54 | 0 | 0 | 1 |

## 3. Decisions

One decision per change, each against the threshold in section 1 as it was declared. None edits the
table. A change whose threshold is met by size is recorded and filed as follow-up work; it is not made
here (FR-016, FR-017).

| Change | Threshold (section 1, verbatim) | Figures | Met | Outcome |
|---|---|---|---|---|
| Per-slice revisions (an IPC shape change) | host cost per flush (project plus `JSON.stringify`) ≥ 8 ms, **or** serialized snapshot ≥ 512 KiB, on the active or large-history fixture | large-history serialized snapshot 780,306 B (762 KiB), above 524,288 B; large-history cost per flush 2.371 ms (sum of p95s), below 8 ms; active snapshot 37,734 B, 0.098 ms | yes, by size | justified, filed as follow-up |
| Raw (non-deep) reactive snapshot state | webview apply-to-next-frame ≥ 16 ms on the active or large-history fixture | active p95 14.4 ms; large-history p95 9.5 ms | no | not adopted |
| List virtualization (History) | the large-history fixture's apply-to-next-frame ≥ 16 ms **and** its median at twice the history ≥ 1.8 times the median at the base size | large-history p95 9.5 ms; median at 2x 10.7 ms against 7.2 ms at base, a ratio of 1.49 | no | not adopted |

**Per-slice revisions** are justified by the size of the large-history snapshot, which is about 1.5 times
the threshold. They need a version, default and migration behaviour for the snapshot and coordination with
the snapshot compatibility rules (FR-017), and they change the IPC shape, so this feature changes
nothing. The follow-up is listed for the operator to file; no filing exists yet, so the decision carries
no follow-up reference.

**Raw snapshot state** stays off: neither the active nor the large-history p95 reaches 16 ms. The
metric's floor (above) means these figures are close to the frame cadence, which is a reason a finer
measurement would be needed before revisiting it, not a reason to read them as a pass for the change.

**List virtualization** stays off: the large-history p95 is below 16 ms and the doubling ratio is below
1.8. The History route also caps its own rendered rows at 200, so the cost would not be driven by rendered
rows in any case.

## 4. Policy observations

**Under the policy the extension ships.** The built sidebar and dashboard were served through the
production renderers with a fresh nonce per response and the exact policy `buildCspMeta` builds, in
Chromium 151.0.7922.34, and every `securitypolicyviolation` they raised was recorded.

- Before this feature, the sidebar and the dashboard mounted with no violation, and the Builder's four
  editors raised 13 `style-src-attr` violations (`blockedURI` `inline`), one per static inline `style`
  attribute. Every computed style they set still held.
- The 13 attributes became classes, and the smoke now records no violation on the sidebar, the dashboard
  or any Builder route. A lint gate keeps static `style` attributes out of the webview's Svelte files; the
  one dynamic attribute (`--wf-arms`, applied through the CSSOM) is not governed by the policy and is the
  only one allowed.

**Template-cloned style attributes.** A control page under the same policy held three things. A
parser-inserted `style` attribute was reported and blocked. An inline script without a nonce was reported
and did not run. A `style` attribute inside a `<template>`, cloned into the page by a nonced script, was
**reported as a violation and still applied**. Svelte builds static markup by cloning templates, which is
why the 13 attributes were reported yet every computed style held. It also means a static `style`
attribute reintroduced into a component fails the smoke by its violation record, not by a visual change.

**Hardening: adopted.** `base-uri 'none'` and `form-action 'none'` were added to the policy for the
smoke's hardened run, and every form the webview mounts was submitted (the Queues tier's add-work form, a
pending Task's inline edit form, and the Models tab's add-model form). No `base-uri` or `form-action`
violation was recorded, so `buildCspMeta` now carries both directives. All three forms prevent the default
submission, so none navigates natively; the observation is that no record appears either way.

This is Chromium under Playwright. VS Code's own webview host is a separate observation, listed under
pending qualification.

## 5. Persisted-state growth

A real `WorkspaceStateStore` over an in-memory memento was driven through a synthetic workspace of 20
queues: each completion appends a history entry and leaves its finished Task in place, and every 250
completions one queue is deleted and a new one created. Bytes are the UTF-8 size of each stored value, and
the projected snapshot. Measured 2026-10-31 on the machine in section 2.

| Completions | Task records | History | Run records | Projected snapshot | History partitions (deleted queues') | Runs held |
|---|---|---|---|---|---|---|
| 0 | 4,412 | 2 | 5,284 | 20,723 | 0 (0) | 10 |
| 100 | 47,478 | 40,825 | 5,284 | 119,491 | 20 (0) | 10 |
| 1,000 | 383,866 | 405,137 | 3,136 | 929,546 | 23 (4) | 6 |
| 5,000 | 1,042,932 | 740,551 | 451 | 2,148,528 | 39 (20) | 1 |

- **Task records grow at every point.** Finished Tasks stay in their queue until the operator clears them.
- **Run records do not grow.** The store keeps only Runs that have not finished, at most one per queue.
  The count falls here only because the retired queues were the ones holding Runs.
- **History grows only through deleted queues' partitions.** The live partitions together never held more
  than 876 entries at any point, fewer than 20 partitions filled to the cap, so each is capped. Deleting a queue does not delete its history partition, so the
  deleted partitions rose from 0 to 4 to 20, and the history with them.
- **The snapshot grows with the partitions**, because it projects every partition: about 2.05 MiB after
  5,000 completions.

`MAX_QUEUES` and `MAX_PENDING_TASKS_PER_QUEUE` do not bound the total persisted size: the first bounds the
number of queues and the second the pending Tasks in one queue, and finished Tasks and deleted queues'
history fall under neither. This is a synthetic workspace; a real long-lived one is pending qualification.

## 6. Retention options

None of these is implemented by this feature, and none deletes anything on its own. Each is listed with
whether it deletes and who would decide.

| Option | Deletes | Decided by | Implemented here |
|---|---|---|---|
| The existing operator clears of completed and failed Tasks | yes, the cleared Tasks | operator action | no, it already exists |
| A display bound on the snapshot's history projection (the newest entries per partition) | no, it bounds what is posted | none (display only) | no |
| An operator action that removes a deleted queue's history partition | yes, that partition | operator action | no |
| A finished-Task cap that moves the oldest finished Tasks out of a queue's `requests` | yes, the moved Tasks | operator policy | no |

Audit history stays append-only, and Run history is kept whole. The authoritative statements of what is
retained, for how long and how it is deleted are [the evidence retention
disclosure](evidence-retention-disclosure.md) and [the data retention and deletion
guide](data-retention-and-deletion.md); this page links to them and states no bound of its own.

## 7. Pending qualification

Each item needs an environment this feature could not run unattended. None is marked passed.

- **A real failing resolver in an installed extension.** Prerequisite: an operator, the installed
  extension, and a catalog that makes one projection throw. Expected: one warning in the System tab's
  debug log per failure episode.
- **A real sidebar hidden and revealed during a Run.** Prerequisite: an operator in VS Code with the
  webview developer tools open. Expected: no state snapshot while hidden, the current state on reveal.
- **VS Code's own webview host under the shipped policy.** Prerequisite: the installed extension with
  the webview developer tools open on the sidebar and on the Builder tabs. Expected: no "Refused to ..."
  console entry.
- **Scroll anchoring in paused mode.** Prerequisite: a browser run of the phase log with more than 499 live
  entries. Expected: the viewport stays on the same rows while the oldest are trimmed.
- **A real long-lived workspace's persisted size.** Prerequisite: a workspace with months of Runs.
- **A screen reader on the Run Detail tabs and Queue Settings.** Prerequisite: an operator with VoiceOver
  or NVDA, including opening Queue Settings with a real key press.
- **Any figure here on another machine.** Prerequisite: the same three measuring files run on that machine.
  Every figure above is darwin/arm64, Chromium 151.0.7922.34, Node v24.19.0.

## 8. Follow-up closure (`FR-R5-F12`, 2026-11-06)

`FR-R5-F12` (`271-measured-snapshot-bounds`) implemented the per-slice revision / unchanged-slice suppression follow-up justified in section 3, coordinated with `FR-R5-F09` (`MAX_DELETED_HISTORY_PARTITIONS = 20`) and `FR-R5-F10` (`MAX_BUILDER_HISTORY_ENTRIES = 50`, `MAX_BUILDER_HISTORY_BYTES = 262,144`):

1. **Contract (`src/contracts/snapshot-bounds.ts`)**: Declares `ROUTINE_SNAPSHOT_BYTE_BUDGET = 524_288` (512 KiB), `FULL_RESYNC_SNAPSHOT_BYTE_CEILING = 1_048_576` (1 MiB), `MAX_RETAINED_HISTORY_PARTITIONS = 40`, `MAX_RETAINED_HISTORY_ENTRIES = 2_000`, `SUPPRESSIBLE_SNAPSHOT_SLICES`, `SnapshotSyncMeta`, and `SNAPSHOT_RESYNC_REQUEST`.
2. **Host & Webview Synchronization (`src/ui/sidebar/snapshot-transport.ts`, `webview-ui/src/lib/snapshot-merge.ts`)**:
   - `HistoryStore.list()` and `projectHistory()` memoize the frozen history projection while partitions are unchanged.
   - `SidebarViewProvider` and `DashboardPanel` deliver `mode: 'full'` on initial resolve, `hidden → visible` reveal, projector replacement, post failure, and `SNAPSHOT_RESYNC_REQUEST`, while omitting unchanged slices in `SUPPRESSIBLE_SNAPSHOT_SLICES` on `mode: 'routine'` updates to continuously visible consumers.
   - `SnapshotStore` reconstructs omitted slices from the verified `baseRevision`, preserves object reference identity for unchanged slices across both `full` and `routine` updates, drops out-of-order (`revision <= lastRevision`) frames, and requests a full resync if a routine frame arrives with a missing or mismatched `baseRevision`.
3. **Measured Results (2026-11-06, `darwin/arm64`, Node `v24.21.0`)**:
   - `large-history` (`2,000` entries): full-resync `780,316` B (`<= 1,048,576` B ceiling), routine update **`16,817` B** (`<= 524,288` B budget), `project()` p50 `0.5021` ms, routine `JSON.stringify` p50 `0.0625` ms / p95 `0.3447` ms.
   - `large-history-2x` (60 deleted partitions attempted via `appendHistory`): bounded by F09 to `40` partitions (`2,000` entries), full-resync `780,316` B, routine update **`16,817` B**.
   - Phase-log 500-row window (2,000 appends): retained `500` rows (`trimmedCount = 1,501`), `86,591` B, append p50 `0.0252` ms / p95 `0.2500` ms (non-virtualized bounded window retained).
   - F10 Builder undo/redo bounds (200 edits): retained `31` entries (`<= 50`) and `261,206` B (`<= 262,144` B), push p50 `0.2302` ms / p95 `1.6453` ms.
   - Cold host activation CPU (`45.30` ms) is recorded separately from the browser two-animation-frame floor (`33.33` ms at 60 Hz); 500 sustained ticks on `large-history` showed zero unbounded heap growth (`heapUsed` `54.4` MiB → `46.1` MiB, `rss` `270.3` MiB).
   - Platforms `linux` and `win32` and live desktop VS Code / AT screen-reader sessions remain listed under section 7's pending qualification.
