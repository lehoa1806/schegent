// FR-R6-F15 T034 — the bounded history of a review loop: the five most recent passes as
// references and counts, the number of older passes, and the last report and blocking count.
import { describe, expect, it } from 'vitest';

import { PHASE_CONTEXT_LIMITS } from '../../../src/contracts/phase-context/context-policy';
import type { PassOutcome } from '../../../src/contracts/phase-context/review-loop';
import { createFindingLedger, type FindingLedger } from '../../../src/services/phase-context/finding-ledger';
import { buildLoopHistory } from '../../../src/services/phase-context/loop-history';
import { finding, marker, reviewReport, textOfBytes } from '../../fixtures/phase-context/builders';

// The history holds no code that reads these three limits: an entry is a fixed set of bounded
// fields, so the bounds follow from its shape. The tests measure them against the contract.
const ENTRY_BYTES_MAX = PHASE_CONTEXT_LIMITS.historyPassBytesMax;
const HISTORY_BYTES_MAX = PHASE_CONTEXT_LIMITS.historyTotalBytesMax;
const REFERENCE_BYTES_MAX = PHASE_CONTEXT_LIMITS.evidenceReferenceBytesMax;

function bytesOf(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function outcome(pass: number, overrides: Partial<PassOutcome> = {}): PassOutcome {
  return {
    pass,
    reportRef: `report@${String(pass)}`,
    verdict: 'needs-fixes',
    blockingCount: 1,
    open: 1,
    resolved: 0,
    newFindings: 0,
    mayDispatchFix: true,
    ...overrides
  };
}

function outcomes(count: number): PassOutcome[] {
  return Array.from({ length: count }, (_unused, index) => outcome(index + 1));
}

/** The longest reference a ledger admits, distinct for each pass. */
function longRef(pass: number): string {
  return textOfBytes(REFERENCE_BYTES_MAX - 2) + String(pass).padStart(2, '0');
}

/**
 * A loop of `passes` passes through a real ledger: pass 1 opens `opened` high findings and
 * every later pass leaves them open, each report under the longest permitted reference.
 */
function loopOf(passes: number, opened: number): FindingLedger {
  const ledger = createFindingLedger({ loopId: 'loop-1', blockingSeverities: ['critical', 'high'], maxPasses: 32 });
  for (let pass = 1; pass <= passes; pass += 1) {
    const report = reviewReport({
      pass,
      previousReportRef: pass === 1 ? null : longRef(pass - 1),
      blockingCount: opened,
      findings:
        pass === 1
          ? Array.from({ length: opened }, (_unused, index) =>
              finding({ id: `F-${String(index + 1)}`, title: marker('title'), explanation: marker('explanation') })
            )
          : [],
      dispositions: []
    });
    const context = { reportRef: longRef(pass), candidateRef: 'candidate@1', scopeRevision: 'scope@1', criteriaRevision: 'criteria@1' };
    const result = ledger.acceptReport(report, context);
    if (!result.ok) throw new Error(`refused: ${JSON.stringify(result)}`);
  }
  return ledger;
}

describe('buildLoopHistory', () => {
  it('gives an empty history when no pass is complete', () => {
    expect(buildLoopHistory([])).toEqual({ entries: [], olderPasses: 0, latestReportRef: null, blockingCount: 0 });
  });

  it('gives one entry for one pass, with its reference and counts and nothing else', () => {
    const history = buildLoopHistory([outcome(1, { blockingCount: 2, open: 3, resolved: 4, newFindings: 5 })]);

    expect(history).toEqual({
      entries: [{ pass: 1, reportRef: 'report@1', verdict: 'needs-fixes', open: 3, resolved: 4, newFindings: 5 }],
      olderPasses: 0,
      latestReportRef: 'report@1',
      blockingCount: 2
    });
    expect(Object.keys(history.entries.at(0) ?? {})).toEqual(['pass', 'reportRef', 'verdict', 'open', 'resolved', 'newFindings']);
  });

  it('keeps five passes whole', () => {
    const history = buildLoopHistory(outcomes(5));

    expect(history.entries.map((entry) => entry.pass)).toEqual([1, 2, 3, 4, 5]);
    expect(history.olderPasses).toBe(0);
  });

  it('keeps the five most recent of seven passes and counts the two older ones (scenario 8)', () => {
    const history = buildLoopHistory(outcomes(7));

    expect(history.entries.map((entry) => entry.pass)).toEqual([3, 4, 5, 6, 7]);
    expect(history.olderPasses).toBe(2);
    expect(history.latestReportRef).toBe('report@7');
  });

  it('counts 27 older passes of the longest loop', () => {
    const history = buildLoopHistory(outcomes(32));

    expect(history.entries.map((entry) => entry.pass)).toEqual([28, 29, 30, 31, 32]);
    expect(history.olderPasses).toBe(27);
  });

  it('takes the last report and the blocking count from the last pass', () => {
    const passes = [outcome(1, { blockingCount: 4 }), outcome(2, { blockingCount: 2 }), outcome(3, { blockingCount: 0, verdict: 'passed' })];

    const history = buildLoopHistory(passes);

    expect(history.latestReportRef).toBe('report@3');
    expect(history.blockingCount).toBe(0);
    expect(history.entries.at(2)?.verdict).toBe('passed');
  });

  it('gives equal results for equal input and leaves its input as it was', () => {
    const passes = outcomes(7);
    const before = JSON.stringify(passes);

    expect(buildLoopHistory(passes)).toEqual(buildLoopHistory(passes));
    expect(JSON.stringify(passes)).toBe(before);
  });

  it('gives entries of its own: a change to one changes no pass', () => {
    const passes = outcomes(2);
    const history = buildLoopHistory(passes);

    (history.entries as unknown[]).pop();

    expect(passes).toHaveLength(2);
    expect(buildLoopHistory(passes).entries).toHaveLength(2);
  });

  describe('over the passes of a ledger', () => {
    it('stays within 1 KiB an entry and 8 KiB in all with the longest references and the largest counts', () => {
      const ledger = loopOf(32, 200);

      const history = buildLoopHistory(ledger.passes());

      expect([ENTRY_BYTES_MAX, HISTORY_BYTES_MAX]).toEqual([1024, 8192]);
      expect(history.entries).toHaveLength(5);
      expect(history.entries.at(4)?.reportRef).toHaveLength(REFERENCE_BYTES_MAX);
      for (const entry of history.entries) expect(bytesOf(entry)).toBeLessThanOrEqual(ENTRY_BYTES_MAX);
      expect(bytesOf(history)).toBeLessThanOrEqual(HISTORY_BYTES_MAX);
    });

    it('still lists every open finding after seven passes (scenario 8)', () => {
      const ledger = loopOf(7, 3);

      const history = buildLoopHistory(ledger.passes());

      expect(history.entries.map((entry) => entry.pass)).toEqual([3, 4, 5, 6, 7]);
      expect(history.olderPasses).toBe(2);
      expect(history.blockingCount).toBe(3);
      expect(history.entries.at(4)).toEqual({ pass: 7, reportRef: longRef(7), verdict: 'needs-fixes', open: 3, resolved: 0, newFindings: 0 });
      expect(ledger.findings().map((entry) => [entry.id, entry.status])).toEqual([
        ['F-1', 'open'],
        ['F-2', 'open'],
        ['F-3', 'open']
      ]);
    });

    it('carries no text of a report', () => {
      const ledger = loopOf(3, 2);

      expect(JSON.stringify(buildLoopHistory(ledger.passes()))).not.toContain('SEEDED');
    });
  });
});
