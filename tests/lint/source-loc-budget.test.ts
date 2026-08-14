import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

const BUDGETS: ReadonlyArray<{ readonly path: string; readonly maxLines: number }> = [
  // P4 activation extraction ratchet: 1,500 → 1,305. Backend/evidence
  // composition and Stage-2 dashboard/command lifecycle now have focused
  // owners under src/activation.
  // Feature 084 (T071) — 1,305 → 1,360 for the two process-YAML host seams.
  // They are the same shape as the metrics adapter they sit beside: closures
  // over `workspaceRoot`, `logger`, and
  // `vscode` that keep every filesystem path out of the IPC boundary. Moving
  // them under src/activation was measured first and lands at ~1,307, so it
  // buys headroom rather than compliance while splitting one adapter family
  // across two files; the ceiling is raised instead.
  // Feature 088 (T040) — 1,360 → 1,362, a recorded deviation from plan D7,
  // which budgeted one line. The connected-run service itself moved out, to
  // `createConnectedRunService` in src/activation/ui-wiring.ts, exactly as D7
  // directed; what could not move is that two already-constructed consumers
  // need the same instance — the projector (`getConnectedRuns`, for the
  // snapshot) and the message router (`connectedRuns`, for the two commands) —
  // and both literals are built here. That is one construction line plus one
  // reference each. Constructing the (stateless) service twice inline would
  // have bought the const line back while putting a factory call inside a
  // per-projection closure, which is worse code for a line of budget.
  { path: 'src/extension.ts', maxLines: 1_362 },
  // P4 phase-control and lifecycle-auditor extraction ratchet: 1,200 → 730.
  // This file owns only the workflow facade, run dispatch, deletion, retry
  // entry, and persistence.
  // Feature 092 (T137, BUG-001) — 730 → 750 for the execution lease's terminal
  // release (FR-033a), against a ceiling that had two lines to give. The logic
  // moved out, to `releaseExecutionLeaseForTerminalRun` in
  // src/services/execution-lease-release.ts; extraction was measured first and
  // buys 44 lines (794 → 750). What could not move is the wiring, and it is in
  // this file by definition: the two terminal transitions the fix exists to
  // cover — `handleUnexpectedWorkflowError` and `deleteTask`'s task-removal
  // cancel — both live here, the `RunDriver` dep that covers the ordinary
  // funnel is constructed here, and the drain coordinator and the terminal path
  // must address the same lease manager, which is what turned one inline
  // constructor argument into a named const. The remainder is one import, one
  // bound field, four constructor lines, and two call sites.
  { path: 'src/controller/workflow-controller.ts', maxLines: 750 },
  // P4 domain-validator extraction ratchet: 1,200 → 775. The registry owns
  // command coverage; phase-log and metrics validators own shape rules.
  // Feature 088 (T032) — 775 → 776 for the two connected-run commands. Both
  // validators live in validators/workflow-run.ts and neither re-states the
  // nested `RunRequest` shape (it is imported from validators/launch-pipeline.ts,
  // so there is one oracle for it, not three). What landed here is the
  // irreducible registration: two literal imports, one module import, and two
  // switch arms — seven lines for two command families, against a ceiling that
  // had seven to give.
  { path: 'src/contracts/runtime-validators.ts', maxLines: 776 },
  // P4 IPC-family extraction ratchet: 1,250 → 885. The stable barrel retains
  // literals and guards while domain wire shapes live in focused modules.
  // Feature 084 (T071) — 885 → 950 for the process-YAML command family. Its
  // wire shapes already live in sidebar-ipc/process-yaml.ts, so what landed
  // here is only what the ratchet says belongs here: two command literals,
  // their guards, and the COMMAND_TYPES / SidebarCommand / COMMAND_GUARDS
  // entries the drift test requires be exhaustive. There is nothing left to
  // extract, so admitting a new family costs barrel lines by construction.
  // Feature 085 (T068) — 950 → 960. No new family: the two process-YAML guards
  // gained bodies, because 085 made the export payload a discriminated union
  // and emptied the preflight payload, and a guard that ignored either would
  // admit a shape the wire type forbids. Moving them into
  // sidebar-ipc/process-yaml.ts was measured first: that module imports the
  // command literals `import type`, so it erases today, and the guards need
  // them as runtime values — extraction buys ten barrel lines by creating a
  // real import cycle where none exists. The ceiling is raised instead.
  // Feature 087 (T008) — 960 → 975 for the run-launcher family. Its wire
  // shapes and its payload predicate both live in sidebar-ipc/run-launcher.ts;
  // extraction was taken as far as it goes, and the predicate moved out
  // precisely because it needs none of this module's runtime values. What
  // remains is the irreducible five: the command literal, the COMMAND_TYPES
  // entry, the type re-export, the SidebarCommand member, and the COMMAND_GUARDS
  // entry — plus the two-line guard that wraps the extracted predicate with the
  // `isObjectWithType` discriminator check, which 085 established cannot leave
  // this file without creating a real import cycle. Admitting a family costs
  // barrel lines by construction; the ceiling is raised rather than the
  // registration split.
  // Feature 088 (T035) — 975 → 1009 for the connected-run family. Two command
  // literals this time, not one, and the same irreducible five apiece; its wire
  // shapes, its projection, and both payload predicates live in
  // sidebar-ipc/workflow-run.ts. The one line item above the 087 pattern is the
  // type re-export block: the projection travels on the snapshot and on two
  // refusal arms, so the webview needs the names, and re-exporting through the
  // barrel is what every other family here does. Measured after registration,
  // not estimated.
  { path: 'src/contracts/sidebar-ipc.ts', maxLines: 1009 },
  // Feature 063 (operator decision 2026-05-22, plan.md "Constitution-style
  // invariants"): per-file caps for queue-manager.ts and workspace-state.ts
  // raised to 10_000 lines. Helpers may be extracted for cohesion, but the
  // budget is no longer the forcing function. See
  // specs/063-clean-all-confirmations/plan.md lines 26 and 66.
  { path: 'src/state/workspace-state.ts', maxLines: 10_000 },
  // Feature 077 — public facade and every state-projection collaborator have
  // hard physical-LOC ceilings. Composition, lifecycle, and timing are split.
  { path: 'src/ui/sidebar/state-projector.ts', maxLines: 250 },
  { path: 'src/ui/sidebar/state-projector-runtime.ts', maxLines: 300 },
  { path: 'src/ui/sidebar/projector-bookkeeping.ts', maxLines: 300 },
  // Feature 087 (T064) — 300 → 301 for the recorded-run-outputs projection
  // (FR-043). The composition itself was extracted first, to
  // `projectRunOutputs` in run-projector.ts; what landed here is the one thing
  // that cannot leave — a call site in the returned object and its name in the
  // existing run-projector import. Packing that import list would have bought
  // the line back while hiding the growth, so the ceiling is raised in the open
  // instead, matching the justified bumps above. Raised to exactly what the
  // file now measures, not to a round number with slack: an unearned ceiling
  // is a budget that has stopped being a forcing function. Recorded as a plan
  // deviation under specs/087-pipeline-run-composition/tasks.md T068.
  // Feature 088 (T039) — 301 → 302 for the connected-run projection. The same
  // shape as the bump above, and for the same reason: the fold lives in
  // connected-run-projector.ts (which also answers the continuation handler's
  // gate 4, so there is one oracle rather than two), and what landed here is
  // the single conditional spread that cannot live anywhere else. The file was
  // measured at exactly 301 before the edit — the note on T039 said zero slack
  // and it was right — so there was no line to absorb it into short of
  // reflowing unrelated code, which would hide the growth rather than record
  // it. Raised to exactly what the file now measures, per D7.
  { path: 'src/ui/sidebar/snapshot-composer.ts', maxLines: 302 },
  { path: 'src/queue/queue-manager.ts', maxLines: 10_000 },
  // Speckit-auto alignment (2026-07-30) — bumped 700 → 800 to absorb two new
  // built-in phases (speckit-checklist, speckit-review) and enriched
  // skill-aligned instruction text for clarify, analyze, review, and finalize.
  // Feature 074 — bumped 800 → 850 for runner field on PhaseDef, ALLOWED_PHASE_FIELDS,
  // isPhaseDef runner check, and validatePhaseRaw runner validation.
  { path: 'src/config/pipeline-config.ts', maxLines: 900 },
  { path: 'src/config/general-settings.ts', maxLines: 650 }
];

function lineCount(path: string): number {
  const contents = readFileSync(resolve(REPO_ROOT, path), 'utf8');
  return contents.length === 0 ? 0 : contents.split(/\r?\n/).length;
}

describe('large source file LOC budgets', () => {
  for (const budget of BUDGETS) {
    it(`${budget.path} stays at or below ${budget.maxLines} lines`, () => {
      const actual = lineCount(budget.path);
      expect(
        actual,
        `${budget.path} has ${actual} lines, over budget ${budget.maxLines}; split new responsibilities into focused modules before adding more behavior`
      ).toBeLessThanOrEqual(budget.maxLines);
    });
  }

  it('every sidebar projector module stays at or below 300 lines', () => {
    const directory = resolve(REPO_ROOT, 'src/ui/sidebar');
    const modules = readdirSync(directory)
      .filter((name) => name.includes('projector') && name.endsWith('.ts'));
    const offenders = modules
      .map((name) => ({ name, lines: lineCount(`src/ui/sidebar/${name}`) }))
      .filter(({ lines }) => lines > 300);
    expect(offenders).toEqual([]);
  });
});
