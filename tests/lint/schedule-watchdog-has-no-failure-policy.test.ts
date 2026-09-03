// Feature 195 (T020, AGENTS.md rule 33) — the failure question has exactly
// one enforcement site: `AutoDrainCoordinator.drainQueueOnce` step 2a. The
// scheduled-start watchdog only asks `promote` to try (research D6); it must
// never grow an opinion of its own about whether a halted queue may start,
// or the drain and the watchdog become two places that could disagree.

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

describe('feature 195 (T020) — schedule-watchdog.ts is not a second halt enforcement site', () => {
  it('references neither the failure-policy vocabulary nor the halt predicate', () => {
    const file = path.resolve(process.cwd(), 'src/controller/schedule-watchdog.ts');
    const source = fs.readFileSync(file, 'utf8');

    const forbidden = [
      'queue-failure-policy',
      'queue-halt-policy',
      'QueueFailurePolicy',
      'evaluateQueueHalt',
      'isBlockingTaskStatus',
      'failurePolicy',
      'halt-on-failure'
    ];
    const found = forbidden.filter((needle) => source.includes(needle));

    expect(
      found,
      'schedule-watchdog.ts must reach the drain\'s own decision through `promote`, ' +
        'never by importing or restating the halt vocabulary or predicate itself:\n' +
        found.join('\n')
    ).toEqual([]);
  });

  // Vacuity control.
  it('the file this test reads actually exists and is non-trivial', () => {
    const file = path.resolve(process.cwd(), 'src/controller/schedule-watchdog.ts');
    const source = fs.readFileSync(file, 'utf8');
    expect(source.length).toBeGreaterThan(500);
  });
});
