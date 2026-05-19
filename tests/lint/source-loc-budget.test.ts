import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

const BUDGETS: ReadonlyArray<{ readonly path: string; readonly maxLines: number }> = [
  { path: 'src/extension.ts', maxLines: 1_350 },
  { path: 'src/controller/workflow-controller.ts', maxLines: 1_050 },
  { path: 'src/contracts/runtime-validators.ts', maxLines: 1_000 },
  { path: 'src/contracts/sidebar-ipc.ts', maxLines: 1_000 },
  { path: 'src/state/workspace-state.ts', maxLines: 900 },
  { path: 'src/ui/sidebar/state-projector.ts', maxLines: 900 },
  { path: 'src/queue/queue-manager.ts', maxLines: 800 },
  { path: 'src/headless/wakeup-runner.ts', maxLines: 725 },
  { path: 'src/config/pipeline-config.ts', maxLines: 700 },
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
