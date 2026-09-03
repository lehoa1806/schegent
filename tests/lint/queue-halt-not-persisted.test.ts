// Feature 195 (T025, FR-003, SC-008) — the grep-provable form of "the halt is
// derived, never stored". Two separate claims, because a passing gate on only
// one is how a stored flag creeps back in unnoticed by the other:
//
//   1. No persisted queue shape (`QueueState`) declares a field describing a
//      halt. `failurePolicy` is the operator's stored choice, not the halt
//      itself, and is explicitly exempted.
//   2. `auto-drain-coordinator.ts` never reads a stored halt flag off
//      `queueState` — it recomputes `evaluateQueueHalt` from `requests` on
//      every attempt (step 2a), and that is the only place the word "halt"
//      may appear reading FROM queue state.

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

describe('feature 195 (T025) — the halt is derived, never persisted', () => {
  it('QueueState declares no field describing a halt other than failurePolicy', () => {
    const file = path.resolve(process.cwd(), 'src/queue/feature-request.ts');
    const source = fs.readFileSync(file, 'utf8');
    const interfaceMatch = source.match(/export interface QueueState \{[\s\S]*?\n\}/);
    expect(interfaceMatch, 'QueueState interface not found').not.toBeNull();
    const body = interfaceMatch![0];

    // Field declarations only — `key: Type` or `key?: Type` at the start of a
    // line inside the interface — so a doc-comment mentioning "halt" in prose
    // does not itself trip this gate.
    const fieldLines = body
      .split('\n')
      .filter((line) => /^\s*[a-zA-Z][a-zA-Z0-9]*\??\s*:/.test(line));
    const haltFields = fieldLines.filter(
      (line) => /halt/i.test(line) && !/failurePolicy/.test(line)
    );

    expect(
      haltFields,
      'QueueState must not declare a field describing a halt (FR-003). ' +
        'The halt is recomputed from `requests` on every attempt; only the ' +
        "operator's own policy choice (`failurePolicy`) is stored:\n" +
        haltFields.join('\n')
    ).toEqual([]);
  });

  it('auto-drain-coordinator.ts reads no stored halt flag off queue state', () => {
    const file = path.resolve(process.cwd(), 'src/services/auto-drain-coordinator.ts');
    const source = fs.readFileSync(file, 'utf8');

    // The only legitimate reads naming "halt" near `queueState` are the two
    // this feature added: the call to `evaluateQueueHalt` (a pure function
    // over `requests`, not a stored field) and its own doc comments. What
    // must never appear is a read shaped like `queueState.<something>Halt`
    // or `queueState.halted` — a field this module recomputes, reading it
    // back off the very state it derives it from.
    const forbidden = /queueState\.\w*[Hh]alt\w*/;
    const match = source.match(forbidden);

    expect(
      match,
      `Found a read of a stored halt-shaped field off queueState: ${match?.[0]}. ` +
        'The halt must be recomputed from queueState.requests via evaluateQueueHalt, ' +
        'never read back as a field of its own.'
    ).toBeNull();
  });

  it('vacuity control: both files actually mention "halt" somewhere, so the gates are exercised', () => {
    const coordinatorSource = fs.readFileSync(
      path.resolve(process.cwd(), 'src/services/auto-drain-coordinator.ts'),
      'utf8'
    );
    expect(/halt/i.test(coordinatorSource)).toBe(true);
  });
});
