import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

const BUDGETS: ReadonlyArray<{ readonly path: string; readonly maxLines: number }> = [
  // Feature 010 BUG-001 (Bugfix 2026-05-22) — bumped +15 to accommodate the
  // FR-028 retry-decision projection sink wired into PhaseRunner construction.
  // Feature 065 (T055 / 2026-05-22) — bumped +50 (1400 → 1450) to absorb the
  // host wiring for the new enqueue/start separation surface: the
  // `ScheduledStartCoordinator` lifecycle, the `dismissMigrationNotice` IPC
  // hook, the status-bar `showTransient` subscriber, and the v6 → v7 migration
  // re-arm path. The feature legitimately extends extension.ts; the alternative
  // (a second activation aggregator file) was rejected to avoid splintering the
  // host registration order.
  { path: 'src/extension.ts', maxLines: 1_500 },
  // P4 phase-control and lifecycle-auditor extraction ratchet: 1,200 → 730.
  // This file owns only the workflow facade, run dispatch, deletion, retry
  // entry, and persistence.
  { path: 'src/controller/workflow-controller.ts', maxLines: 730 },
  { path: 'src/contracts/runtime-validators.ts', maxLines: 1_200 },
  { path: 'src/contracts/sidebar-ipc.ts', maxLines: 1_250 },
  // Feature 063 (operator decision 2026-05-22, plan.md "Constitution-style
  // invariants"): per-file caps for queue-manager.ts and workspace-state.ts
  // raised to 10_000 lines. Helpers may be extracted for cohesion, but the
  // budget is no longer the forcing function. See
  // specs/063-clean-all-confirmations/plan.md lines 26 and 66.
  { path: 'src/state/workspace-state.ts', maxLines: 10_000 },
  { path: 'src/ui/sidebar/state-projector.ts', maxLines: 920 },
  { path: 'src/queue/queue-manager.ts', maxLines: 10_000 },
  { path: 'src/headless/wakeup-runner.ts', maxLines: 725 },
  // Speckit-auto alignment (2026-07-30) — bumped 700 → 800 to absorb two new
  // built-in phases (speckit-checklist, speckit-review) and enriched
  // skill-aligned instruction text for clarify, analyze, review, and finalize.
  // Feature 074 — bumped 800 → 850 for runner field on PhaseDef, ALLOWED_PHASE_FIELDS,
  // isPhaseDef runner check, and validatePhaseRaw runner validation.
  { path: 'src/config/pipeline-config.ts', maxLines: 850 },
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
});
