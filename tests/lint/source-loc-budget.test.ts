import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

const BUDGETS: ReadonlyArray<{ readonly path: string; readonly maxLines: number }> = [
  // P4 activation extraction ratchet: 1,500 → 1,305. Backend/evidence
  // composition and Stage-2 dashboard/command lifecycle now have focused
  // owners under src/activation.
  // Feature 084 (T071) — 1,305 → 1,360 for the two process-YAML host seams.
  // They are the same shape as the `revealWakeupSessionLog` and metrics
  // adapters they sit beside: closures over `workspaceRoot`, `logger`, and
  // `vscode` that keep every filesystem path out of the IPC boundary. Moving
  // them under src/activation was measured first and lands at ~1,307, so it
  // buys headroom rather than compliance while splitting one adapter family
  // across two files; the ceiling is raised instead.
  { path: 'src/extension.ts', maxLines: 1_360 },
  // P4 phase-control and lifecycle-auditor extraction ratchet: 1,200 → 730.
  // This file owns only the workflow facade, run dispatch, deletion, retry
  // entry, and persistence.
  { path: 'src/controller/workflow-controller.ts', maxLines: 730 },
  // P4 domain-validator extraction ratchet: 1,200 → 775. The registry owns
  // command coverage; phase-log, wake-up, and metrics validators own shape rules.
  { path: 'src/contracts/runtime-validators.ts', maxLines: 775 },
  // P4 IPC-family extraction ratchet: 1,250 → 885. The stable barrel retains
  // literals and guards while domain wire shapes live in focused modules.
  // Feature 084 (T071) — 885 → 950 for the process-YAML command family. Its
  // wire shapes already live in sidebar-ipc/process-yaml.ts, so what landed
  // here is only what the ratchet says belongs here: two command literals,
  // their guards, and the COMMAND_TYPES / SidebarCommand / COMMAND_GUARDS
  // entries the drift test requires be exhaustive. There is nothing left to
  // extract, so admitting a new family costs barrel lines by construction.
  { path: 'src/contracts/sidebar-ipc.ts', maxLines: 950 },
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
  { path: 'src/ui/sidebar/snapshot-composer.ts', maxLines: 300 },
  { path: 'src/queue/queue-manager.ts', maxLines: 10_000 },
  { path: 'src/headless/wakeup-runner.ts', maxLines: 725 },
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
