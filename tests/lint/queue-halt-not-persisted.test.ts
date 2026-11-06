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

// FR-R5-F19 (spec 278, FR-027; task T050) — the same claim, widened from one file to the whole of `src/`.
//
// Feature 278 adds a decision-blocker notice and a decision-record command that read a Run's blocked
// state. The risk is that one of them keeps its own "this queue is halted" marker so it need not
// recompute. Claim 2 above looks at one file, so it would not see a second site. These cases look at
// every production source file: none reads or writes a halt-shaped property of a queue's persisted
// state, and none declares a halt-shaped key a state could store. The modules this feature added name
// no halt at all, which is checked by name so a later edit that adds one has to answer here.
describe('FR-R5-F19 FR-027 — no second site stores or reads a queue halt', () => {
  const srcRoot = path.resolve(process.cwd(), 'src');
  const STORED_HALT_ACCESS = /queueStates?(\.|\[[^\]]*\]\.)\w*halt\w*/i;
  const STORED_HALT_KEY = /\b(isHalted|halted|queueHalted|haltedAt|haltReason)\??\s*:/;
  const FEATURE_278_MODULES = [
    'src/services/blocker-notice.ts',
    'src/state/pending-retry-shape.ts',
    'src/activation/decision-record-wiring.ts',
    'src/contracts/decision-record.ts'
  ];

  function productionSources(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return productionSources(full);
      return entry.name.endsWith('.ts') ? [full] : [];
    });
  }

  const sources = productionSources(srcRoot).map((file) => ({ file, text: fs.readFileSync(file, 'utf8') }));

  it('no production file reads or writes a halt-shaped property of queue state', () => {
    const offenders = sources.filter(({ text }) => STORED_HALT_ACCESS.test(text)).map(({ file }) => file);

    expect(offenders).toEqual([]);
  });

  it('no production file declares a halt-shaped key a persisted state could carry', () => {
    const offenders = sources.filter(({ text }) => STORED_HALT_KEY.test(text)).map(({ file }) => file);

    expect(offenders).toEqual([]);
  });

  it('the modules feature 278 added name no halt', () => {
    for (const rel of FEATURE_278_MODULES) {
      const text = fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8');
      expect(/halt/i.test(text), `${rel} names a halt`).toBe(false);
    }
  });

  it('control: both patterns match a stored-halt shape, and the scan reads the derivation', () => {
    expect(STORED_HALT_ACCESS.test('const h = queueState.halted;')).toBe(true);
    expect(STORED_HALT_ACCESS.test('queueStates[id].haltReason = 1;')).toBe(true);
    expect(STORED_HALT_KEY.test('interface S { halted?: boolean }')).toBe(true);
    // The scan is not reading an empty tree: the one legitimate site, the derivation, is in it.
    const withDerivation = sources.filter(({ text }) => text.includes('evaluateQueueHalt')).map(({ file }) => path.basename(file));
    expect(withDerivation).toContain('auto-drain-coordinator.ts');
    expect(sources.length).toBeGreaterThan(100);
  });
});
