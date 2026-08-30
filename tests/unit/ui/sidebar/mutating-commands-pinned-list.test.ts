// Feature 012 T050 — MUTATING_COMMANDS pinned-list regression test.
// Feature 056 Track 1 (FR-001..FR-005) — Reclassified the four catalog /
// general-settings save commands as mutating. The prior assertion that
// they were NOT mutating encoded the F-001 documentation-vs-implementation
// drift and is now flipped.
//
// Feature 089 T025 (FR-026) — Pinned the four process-platform commands the
// snapshot had never named: the Workflow catalog save (083) and the three
// run-launch commands (087, 088).
// Feature 089 T026 (FR-026, FR-027) — Added the complement assertion, and
// completed the snapshot to the whole live set on the way. See the two blocks
// at the foot of this file.
//
// MUTATING_COMMANDS is the only gate preventing a secondary VS Code host
// from mutating workspace settings during a multi-window session
// (CLAUDE.md hard rule). This test pins the current set as a snapshot so
// any accidental drop during a refactor is caught immediately.

import { describe, it, expect } from 'vitest';
import {
  CMD_REMOVE_QUEUE_ITEM,
  CMD_RETRY_QUEUE_ITEM,
  CMD_MOVE_QUEUE_ITEM_UP,
  CMD_MOVE_QUEUE_ITEM_DOWN,
  CMD_CLEAR_COMPLETED,
  CMD_PAUSE_QUEUE,
  CMD_RESUME_QUEUE,
  CMD_RERUN_FROM_HISTORY,
  CMD_START,
  CMD_CANCEL,
  CMD_SAVE_MODELS,
  CMD_SAVE_GENERAL_SETTINGS,
  CMD_RETRY_PHASE_NOW,
  CMD_SAVE_DEFINITION_DRAFT,
  CMD_PUBLISH_DEFINITION,
  CMD_DEACTIVATE_DEFINITION,
  CMD_RESTORE_DEFINITION_VERSION,
  CMD_DISCARD_DEFINITION_DRAFT,
  CMD_PUBLISH_PACKAGE,
  CMD_LAUNCH_PIPELINE,
  CMD_LAUNCH_WORKFLOW,
  CMD_CONTINUE_WORKFLOW,
  CMD_PAUSE_PHASE,
  CMD_RESUME_PHASE,
  CMD_RESTART_PHASE,
  CMD_SKIP_PHASE,
  CMD_DISABLE_PHASE,
  CMD_ENABLE_PHASE,
  CMD_REMOVE_TASK_PHASE,
  CMD_MODIFY_TASK,
  CMD_REORDER_TASK,
  CMD_RESTART_CANCELED_TASK,
  CMD_SET_PHASE_BREAKPOINT,
  CMD_CLEAR_PHASE_BREAKPOINT,
  CMD_START_QUEUE,
  CMD_CLEAR_ALL,
  CMD_SET_CONFIRM_SUPPRESSION,
  CMD_DISMISS_MIGRATION_NOTICE,
  CMD_EXPORT_PROCESS_YAML,
  CMD_PREFLIGHT_PROCESS_YAML,
  CMD_CREATE_QUEUE,
  CMD_RENAME_QUEUE,
  CMD_DELETE_QUEUE,
  CMD_SAVE_QUEUE_SETTINGS,
  CMD_MOVE_TASK,
  CMD_SET_UNCONTAINED_BACKEND_GRANT
} from '../../../../src/ui/sidebar/messages';
import { MUTATING_COMMAND_TYPES } from '../../../../src/contracts/sidebar-command-metadata';
import { isMutatingCommand } from '../../../../src/ui/sidebar/message-router';

const PINNED_MUTATING_COMMANDS: ReadonlyArray<string> = [
  CMD_REMOVE_QUEUE_ITEM,
  CMD_RETRY_QUEUE_ITEM,
  CMD_MOVE_QUEUE_ITEM_UP,
  CMD_MOVE_QUEUE_ITEM_DOWN,
  CMD_CLEAR_COMPLETED,
  CMD_PAUSE_QUEUE,
  CMD_RESUME_QUEUE,
  CMD_RERUN_FROM_HISTORY,
  CMD_START,
  CMD_CANCEL,
  // The lifecycle round-check of 2026-08-30 (finding D) retired four pins from
  // this block: `CMD_CLEAR_FAILED`, `CMD_RETRY_ACTIVE_RUN`, `CMD_RESUME`, and
  // `CMD_RESET`. All four were registered, gated, and reachable from no webview
  // surface after FR-R3-140 deleted `ControlPanel.svelte`. Removing them from
  // the gate and from this mirror is the deliberate removal the second
  // complement assertion below demands, not an accidental demotion: the
  // capabilities survive as palette commands, which the primacy guard covers
  // separately. The count moved 46 -> 42 for exactly that reason.
  CMD_RETRY_PHASE_NOW,
  // Feature 056 Track 1 (FR-001..FR-005). Catalog and general-settings
  // saves write VS Code configuration / workspace state.
  CMD_SAVE_GENERAL_SETTINGS,
  // Feature 100 (T509) — `CMD_SAVE_PHASES`, `CMD_SAVE_PIPELINES`, and
  // `CMD_SAVE_WORKFLOWS` were removed with the whole-array layer envelope.
  // The Model Catalog is the last catalog still written through configuration.
  CMD_SAVE_MODELS,
  // Feature 100 (T507) — the per-definition lifecycle. Every one of the six
  // writes the catalog store: the first three write a version record and move
  // the draft pointer, the publications move the active pointer, and the
  // deactivation and the discard move a pointer off. Five of the six carry no
  // verb the naming-convention lint recognises, so this fixture is what proves
  // they are gated.
  CMD_SAVE_DEFINITION_DRAFT,
  CMD_RESTORE_DEFINITION_VERSION,
  CMD_DISCARD_DEFINITION_DRAFT,
  CMD_PUBLISH_DEFINITION,
  CMD_PUBLISH_PACKAGE,
  CMD_DEACTIVATE_DEFINITION,
  // Feature 087 (T009) — Pipeline run composition. Admits a queue item and a
  // Run: appends to the queue memento and creates durable state.
  CMD_LAUNCH_PIPELINE,
  // Feature 088 (T032) — connected Workflow runs. The launch creates the
  // aggregate and enqueues its first child; the continuation enqueues a child
  // and increments the run's revision.
  //
  // None of these three names carries a mutating verb prefix, so the
  // naming-convention lint would not have caught an omission here. That is
  // precisely why they are pinned by hand.
  CMD_LAUNCH_WORKFLOW,
  CMD_CONTINUE_WORKFLOW,
  // Feature 089 T026 (FR-026) — the entries below had been mutating for
  // several releases and were never pinned. The snapshot was taken at
  // Feature 012 and only ever grew when someone remembered; FR-026's second
  // clause ("the pinned list MUST name every such command the platform now
  // has") is what closes that gap, and the complement assertion at the foot
  // of this file is what keeps it closed.
  //
  // Feature 017 — phase controls. Each writes an override onto the run.
  CMD_PAUSE_PHASE,
  CMD_RESUME_PHASE,
  CMD_RESTART_PHASE,
  CMD_SKIP_PHASE,
  CMD_DISABLE_PHASE,
  CMD_ENABLE_PHASE,
  CMD_REMOVE_TASK_PHASE,
  // Feature 017 task CRUD, narrowed to reorder-only by Feature 030.
  CMD_MODIFY_TASK,
  CMD_REORDER_TASK,
  // Feature 017 BUG-001 — transitions a canceled request back to pending.
  CMD_RESTART_CANCELED_TASK,
  // Feature 028 — future-phase breakpoints. Both write to the run.
  CMD_SET_PHASE_BREAKPOINT,
  CMD_CLEAR_PHASE_BREAKPOINT,
  // BUG-002 (FR-012a) — promotes a pending task to in-flight.
  CMD_START_QUEUE,
  // Feature 063 — atomic Clean All, and the confirmation-suppression
  // preference write.
  CMD_CLEAR_ALL,
  CMD_SET_CONFIRM_SUPPRESSION,
  // Feature 092 (FR-019, FR-020) — the seven queue commands Feature 030
  // retired when the registry collapsed to one queue. Each writes the queue
  // registry memento: six mutate a registry entry (create, rename, delete,
  // arm/clear a scheduled start, save a queue's settings) and CMD_MOVE_TASK
  // moves a Task between two entries, so it writes both. They are gated for
  // the same reason as every command above — a secondary window must not
  // reshape the workspace's queues.
  CMD_CREATE_QUEUE,
  CMD_RENAME_QUEUE,
  CMD_DELETE_QUEUE,
  CMD_SAVE_QUEUE_SETTINGS,
  CMD_MOVE_TASK,
  // FR-R3-144 (T017) — writes `schegent.backend.uncontainedBackends` at
  // application scope: the list naming which backends may be spawned with no
  // containment mechanism. Gated for a stronger reason than the rest of this
  // table. Every other entry reshapes work inside the workspace; this one
  // widens what a spawned process is permitted to touch, and it does so for
  // the whole installation rather than one workspace. A secondary window
  // granting that on the operator's behalf is the exact scenario the gate
  // exists for.
  CMD_SET_UNCONTAINED_BACKEND_GRANT
];

// Feature 089 T026 (FR-027) — commands whose own declaration in
// `src/contracts/sidebar-ipc.ts` records a decision NOT to gate them.
//
// The scope is deliberate and not "every non-mutating command": most of the
// IPC surface is plainly read-only and needs no defence. These three are the
// ones an author could reasonably have expected to be mutating — one writes a
// document, one writes a memento — so each was reasoned about and the
// reasoning was written down. FR-027 asks that the reason exist; this table is
// where the fixture can check that it still holds.
const NON_MUTATING_BY_DESIGN: ReadonlyArray<readonly [string, string]> = [
  [
    CMD_DISMISS_MIGRATION_NOTICE,
    'Feature 065 (FR-020) — writes one UI flag and no workflow, queue, or ' +
      'task state; dismissing a notice is non-destructive UX state.'
  ],
  [
    CMD_EXPORT_PROCESS_YAML,
    'Feature 084 — writes a file the operator named in a host dialog and ' +
      'changes no extension state.'
  ],
  [
    CMD_PREFLIGHT_PROCESS_YAML,
    'Feature 084 — reads the chosen document once and returns a plan; the ' +
      'write it precedes goes through CMD_PUBLISH_PACKAGE, which is gated.'
  ]
];

describe('Feature 012 T050 — MUTATING_COMMANDS pinned-list regression', () => {
  it('contains every command in the pinned pre-refactor list', () => {
    const missing: string[] = [];
    for (const cmd of PINNED_MUTATING_COMMANDS) {
      if (!isMutatingCommand(cmd)) missing.push(cmd);
    }
    expect(missing).toEqual([]);
  });

  it('config save commands ARE mutating (Feature 056 Track 1, FR-001..FR-005)', () => {
    expect(isMutatingCommand(CMD_SAVE_MODELS)).toBe(true);
    expect(isMutatingCommand(CMD_SAVE_GENERAL_SETTINGS)).toBe(true);
  });

  // Feature 100 (T509) — the three layer saves became six per-definition
  // operations, and every one of the six is gated. The count below moved 43 -> 49
  // -> 46 across features 099 and 100 for exactly that reason.
  it('every lifecycle command IS mutating (Feature 100, FR-047, FR-048)', () => {
    expect(isMutatingCommand(CMD_SAVE_DEFINITION_DRAFT)).toBe(true);
    expect(isMutatingCommand(CMD_PUBLISH_DEFINITION)).toBe(true);
    expect(isMutatingCommand(CMD_DEACTIVATE_DEFINITION)).toBe(true);
    expect(isMutatingCommand(CMD_RESTORE_DEFINITION_VERSION)).toBe(true);
    expect(isMutatingCommand(CMD_DISCARD_DEFINITION_DRAFT)).toBe(true);
    expect(isMutatingCommand(CMD_PUBLISH_PACKAGE)).toBe(true);
  });

  it('still gates CMD_RETRY_PHASE_NOW as a mutating command', () => {
    expect(isMutatingCommand(CMD_RETRY_PHASE_NOW)).toBe(true);
  });

  it('reports a non-listed command as non-mutating', () => {
    expect(isMutatingCommand('CMD_NONEXISTENT_BOGUS')).toBe(false);
  });

  // Feature 084 T024 (research R2, QS-40). Phase export writes a file the
  // operator named in the host's own save dialog and changes no extension
  // state, so it is deliberately absent from MUTATING_COMMANDS: gating it
  // there would block export from a secondary window and from an untrusted
  // workspace for no safety gain. Import commits through the existing
  // CMD_PUBLISH_PACKAGE, which IS gated, so the exchange feature adds no
  // mutating command.
  it('does NOT gate CMD_EXPORT_PROCESS_YAML as mutating, and leaves the pinned list at 43', () => {
    expect(isMutatingCommand(CMD_EXPORT_PROCESS_YAML)).toBe(false);
    expect(PINNED_MUTATING_COMMANDS).not.toContain(CMD_EXPORT_PROCESS_YAML);
    expect(PINNED_MUTATING_COMMANDS).toHaveLength(43);
  });

  // Feature 084 T032 (FR-031, FR-032). Preflight reads the operator's chosen
  // document once and returns a plan. It writes no configuration and moves no
  // layer revision, so it is not mutating either; the write it precedes goes
  // through CMD_PUBLISH_PACKAGE, which is gated.
  it('does NOT gate CMD_PREFLIGHT_PROCESS_YAML as mutating, and leaves the pinned list at 43', () => {
    expect(isMutatingCommand(CMD_PREFLIGHT_PROCESS_YAML)).toBe(false);
    expect(PINNED_MUTATING_COMMANDS).not.toContain(CMD_PREFLIGHT_PROCESS_YAML);
    expect(PINNED_MUTATING_COMMANDS).toHaveLength(43);
  });
});

// Feature 089 (T026, US5, FR-026, FR-027) — the complement.
//
// Everything above reads in one direction: for each command the fixture names,
// is it still mutating? That catches a **demotion** — a pinned command dropped
// from `MUTATING_COMMAND_REASONS` during a refactor. It cannot catch an
// **omission**, which is the failure that actually happened: a command was
// registered as mutating and nobody added it here. Before T025/T026 the fixture
// pinned 19 of the 40 commands the platform gated at the time — 21 unpinned,
// the oldest for several releases — and every test in this file passed
// throughout.
//
// This block reads the other way — for each command the platform gates, is it
// named here? — and that is the direction FR-026's second clause states.
//
// The list stays hand-written on purpose. Deriving it from
// `MUTATING_COMMAND_TYPES` would make every assertion in this file
// `X === X`: a command deleted from the gate would vanish from both sides at
// once and the fixture would report clean on the exact change it exists to
// catch. The cost of writing it by hand is one line per new mutating command,
// paid by the author who adds the command, which is the point.
describe('Feature 089 T026 — the pinned list names every gated command (FR-026)', () => {
  it('pins every command in the live mutating set', () => {
    const pinned = new Set(PINNED_MUTATING_COMMANDS);
    const unpinned = MUTATING_COMMAND_TYPES.filter((type) => !pinned.has(type));

    // If this fails, a mutating command was registered without being pinned.
    // Add it to PINNED_MUTATING_COMMANDS above with a comment naming the
    // feature and what it writes — do not delete it from the gate.
    expect(unpinned).toEqual([]);
  });

  it('pins nothing the live mutating set does not gate, and pins nothing twice', () => {
    const live = new Set<string>(MUTATING_COMMAND_TYPES);
    const stale = PINNED_MUTATING_COMMANDS.filter((type) => !live.has(type));

    // The pin is a mirror, not an archive: a command retired from the gate has
    // to be removed here too, deliberately, rather than left behind to make the
    // count look right.
    expect(stale).toEqual([]);
    // A duplicate would satisfy the length assertions above while leaving a
    // real command unpinned, so the count is only meaningful alongside this.
    expect(new Set(PINNED_MUTATING_COMMANDS).size).toBe(PINNED_MUTATING_COMMANDS.length);
  });
});

describe('Feature 089 T026 — deliberate exclusions carry a recorded reason (FR-027)', () => {
  it('records a substantive reason for each command kept out of the gate', () => {
    expect(NON_MUTATING_BY_DESIGN.length).toBeGreaterThan(0);
    for (const [command, reason] of NON_MUTATING_BY_DESIGN) {
      // A reason has to say something. The floor is deliberately low — this
      // asserts a reason was written, not that it is a good one.
      expect(reason.length, `${command} carries no recorded reason`).toBeGreaterThan(40);
    }
  });

  it('holds only commands that really are outside the gate', () => {
    // The record goes stale the moment one of these is reclassified as
    // mutating. That is a decision worth forcing back through this file rather
    // than letting a comment quietly contradict the gate.
    for (const [command] of NON_MUTATING_BY_DESIGN) {
      expect(isMutatingCommand(command), `${command} is gated but recorded as excluded`).toBe(
        false
      );
      expect(PINNED_MUTATING_COMMANDS).not.toContain(command);
    }
  });
});
