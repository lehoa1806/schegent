// FR-R6-F15 T032 — the finding ledger of one review loop: every row of the contract's Review
// loop table and of the status transitions, US4 scenarios 1 to 6, the three verdicts, and
// fixer claims recorded beside the reviewer's statuses without changing one.
import { describe, expect, it } from 'vitest';

import type { FindingStatus, FixClaims, NewFinding, ReviewReport, Severity } from '../../../src/contracts/phase-context/review-loop';
import { createFindingLedger, type FindingLedger, type ReportContext } from '../../../src/services/phase-context/finding-ledger';
import { finding, fixClaims, marker, reviewReport, textOfBytes } from '../../fixtures/phase-context/builders';

const BLOCKING: readonly Severity[] = ['critical', 'high'];

function refusal(failure: string, detail: string): { ok: false; failure: string; detail: string } {
  return { ok: false, failure, detail };
}

function ledgerOf(maxPasses = 8, blockingSeverities: readonly Severity[] = BLOCKING): FindingLedger {
  return createFindingLedger({ loopId: 'loop-1', blockingSeverities, maxPasses });
}

function refOf(pass: number): string {
  return `report@${String(pass)}`;
}

function contextOf(pass: number, overrides: Partial<ReportContext> = {}): ReportContext {
  return { reportRef: refOf(pass), candidateRef: 'candidate@1', scopeRevision: 'scope@1', criteriaRevision: 'criteria@1', ...overrides };
}

/** A report of `pass` that follows the report of the pass before it. */
function reportOf(pass: number, overrides: Partial<ReviewReport> = {}): ReviewReport {
  return reviewReport({ pass, previousReportRef: pass === 1 ? null : refOf(pass - 1), findings: [], dispositions: [], ...overrides });
}

function accept(ledger: FindingLedger, pass: number, overrides: Partial<ReviewReport> = {}): void {
  const result = ledger.acceptReport(reportOf(pass, overrides), contextOf(pass));
  if (!result.ok) throw new Error(`refused: ${JSON.stringify(result)}`);
}

function stateOf(ledger: FindingLedger): string {
  return JSON.stringify([ledger.findings(), ledger.passes()]);
}

function statusOf(ledger: FindingLedger, id: string): FindingStatus | undefined {
  return ledger.findings().find((entry) => entry.id === id)?.status;
}

function manyFindings(count: number, prefix: string, severity: Severity = 'info'): NewFinding[] {
  return Array.from({ length: count }, (_unused, index) => finding({ id: `${prefix}-${String(index + 1)}`, severity }));
}

/** A ledger with one high finding `F-1` opened in pass 1. */
function openedLedger(maxPasses = 8): FindingLedger {
  const ledger = ledgerOf(maxPasses);
  accept(ledger, 1, { findings: [finding()], blockingCount: 1 });
  return ledger;
}

/** A ledger with `F-1` opened in pass 1 and resolved in pass 2. */
function resolvedLedger(): FindingLedger {
  const ledger = openedLedger();
  accept(ledger, 2, { dispositions: [{ findingId: 'F-1', status: 'resolved' }], blockingCount: 0, reviewPassed: true });
  return ledger;
}

describe('a new ledger', () => {
  it('holds no finding and no pass', () => {
    const ledger = ledgerOf();

    expect(ledger.findings()).toEqual([]);
    expect(ledger.passes()).toEqual([]);
  });

  it.each([
    ['a loop identity with a space', { loopId: 'loop 1', blockingSeverities: BLOCKING, maxPasses: 8 }],
    ['an empty loop identity', { loopId: '', blockingSeverities: BLOCKING, maxPasses: 8 }],
    ['no pass', { loopId: 'loop-1', blockingSeverities: BLOCKING, maxPasses: 0 }],
    ['33 passes', { loopId: 'loop-1', blockingSeverities: BLOCKING, maxPasses: 33 }],
    ['a pass limit that is a fraction', { loopId: 'loop-1', blockingSeverities: BLOCKING, maxPasses: 2.5 }],
    ['a severity the contract does not name', { loopId: 'loop-1', blockingSeverities: ['blocker' as Severity], maxPasses: 8 }],
    ['severities that are not a list', { loopId: 'loop-1', blockingSeverities: 'high' as unknown as Severity[], maxPasses: 8 }]
  ])('refuses every report and claim set when it is made with %s', (_label, options) => {
    const ledger = createFindingLedger(options);

    expect(ledger.acceptReport(reportOf(1, { loopId: options.loopId }), contextOf(1))).toEqual(refusal('invalid-policy', 'ledger-options'));
    expect(ledger.recordClaims(fixClaims({ loopId: options.loopId }), { candidateRef: 'candidate@1' })).toEqual(
      refusal('invalid-policy', 'ledger-options')
    );
    expect(ledger.findings()).toEqual([]);
    expect(ledger.passes()).toEqual([]);
  });

  it('accepts 32 passes and an empty blocking set', () => {
    const ledger = createFindingLedger({ loopId: 'loop-1', blockingSeverities: [], maxPasses: 32 });

    const result = ledger.acceptReport(reportOf(1, { findings: [finding({ severity: 'critical' })], blockingCount: 0, reviewPassed: true }), contextOf(1));

    expect(result).toMatchObject({ ok: true, outcome: { verdict: 'passed', blockingCount: 0, open: 1 } });
  });

  it('is not changed by a later change to the list it was made with', () => {
    const severities: Severity[] = ['high'];
    const ledger = createFindingLedger({ loopId: 'loop-1', blockingSeverities: severities, maxPasses: 8 });
    severities.pop();

    const result = ledger.acceptReport(reportOf(1, { findings: [finding()], blockingCount: 1 }), contextOf(1));

    expect(result).toMatchObject({ ok: true, outcome: { verdict: 'needs-fixes', blockingCount: 1 } });
  });
});

describe('acceptReport', () => {
  it('opens the findings of a first report and asks for fixes (scenario 1)', () => {
    const ledger = ledgerOf();
    const report = reportOf(1, { findings: [finding(), finding({ id: 'F-2', severity: 'critical' })], blockingCount: 2 });

    const result = ledger.acceptReport(report, contextOf(1));

    expect(result).toEqual({
      ok: true,
      outcome: { pass: 1, reportRef: 'report@1', verdict: 'needs-fixes', blockingCount: 2, open: 2, resolved: 0, newFindings: 2, mayDispatchFix: true }
    });
    expect(ledger.findings()).toEqual([
      { id: 'F-1', severity: 'high', status: 'open', openedInPass: 1, history: [{ pass: 1, status: 'open' }], claims: [] },
      { id: 'F-2', severity: 'critical', status: 'open', openedInPass: 1, history: [{ pass: 1, status: 'open' }], claims: [] }
    ]);
    expect(ledger.passes()).toEqual([
      { pass: 1, reportRef: 'report@1', verdict: 'needs-fixes', blockingCount: 2, open: 2, resolved: 0, newFindings: 2, mayDispatchFix: true }
    ]);
  });

  it('keeps an open finding that a later report does not mention, and that report cannot pass (scenario 3)', () => {
    const ledger = openedLedger();
    const before = stateOf(ledger);

    expect(ledger.acceptReport(reportOf(2, { reviewPassed: true, blockingCount: 0 }), contextOf(2))).toEqual(
      refusal('invalid-source', 'verdict-mismatch')
    );
    expect(stateOf(ledger)).toBe(before);

    const result = ledger.acceptReport(reportOf(2, { blockingCount: 1 }), contextOf(2));

    expect(result).toMatchObject({ ok: true, outcome: { pass: 2, verdict: 'needs-fixes', blockingCount: 1, open: 1, newFindings: 0 } });
    expect(ledger.findings()).toEqual([
      { id: 'F-1', severity: 'high', status: 'open', openedInPass: 1, history: [{ pass: 1, status: 'open' }], claims: [] }
    ]);
  });

  it('reopens a resolved finding and keeps its earlier resolution in the history (scenario 4)', () => {
    const ledger = resolvedLedger();

    const result = ledger.acceptReport(reportOf(3, { dispositions: [{ findingId: 'F-1', status: 'reopened' }], blockingCount: 1 }), contextOf(3));

    expect(result).toMatchObject({ ok: true, outcome: { verdict: 'needs-fixes', blockingCount: 1, open: 1, resolved: 0 } });
    expect(ledger.findings().at(0)).toEqual({
      id: 'F-1',
      severity: 'high',
      status: 'reopened',
      openedInPass: 1,
      history: [
        { pass: 1, status: 'open' },
        { pass: 2, status: 'resolved' },
        { pass: 3, status: 'reopened' }
      ],
      claims: []
    });
  });

  it('refuses a report that says it passed while a blocking finding is open, and gives no verdict (scenario 5)', () => {
    const ledger = ledgerOf();
    const report = reportOf(1, { findings: [finding()], reviewPassed: true, blockingCount: 0 });

    expect(ledger.acceptReport(report, contextOf(1))).toEqual(refusal('invalid-source', 'verdict-mismatch'));
    expect(ledger.findings()).toEqual([]);
    expect(ledger.passes()).toEqual([]);
  });

  it.each([
    ['a blocking count too low', { findings: [finding()], blockingCount: 0 }],
    ['a blocking count too high', { findings: [finding()], blockingCount: 2 }],
    ['a pass claimed with a blocking finding open', { findings: [finding()], blockingCount: 1, reviewPassed: true }],
    ['no pass claimed with nothing open and complete coverage', { blockingCount: 0, reviewPassed: false }],
    ['a pass claimed with partial coverage', { coverage: 'partial' as const, blockingCount: 0, reviewPassed: true }],
    ['a finding below the blocking set counted', { findings: [finding({ severity: 'medium' })], blockingCount: 1 }]
  ])('refuses a report with %s', (_label, overrides) => {
    const ledger = ledgerOf();

    expect(ledger.acceptReport(reportOf(1, overrides), contextOf(1))).toEqual(refusal('invalid-source', 'verdict-mismatch'));
    expect(ledger.passes()).toEqual([]);
  });

  describe('the verdict', () => {
    it('is needs-fixes while a finding of a blocking severity is not resolved', () => {
      const ledger = ledgerOf();

      const result = ledger.acceptReport(reportOf(1, { findings: [finding({ severity: 'critical' })], blockingCount: 1, coverage: 'partial' }), contextOf(1));

      expect(result).toMatchObject({ ok: true, outcome: { verdict: 'needs-fixes', mayDispatchFix: true } });
    });

    it('is passed when none is and coverage is complete, whatever is open below the blocking set', () => {
      const ledger = ledgerOf();
      const below = [finding({ id: 'F-1', severity: 'medium' }), finding({ id: 'F-2', severity: 'low' }), finding({ id: 'F-3', severity: 'info' })];

      const result = ledger.acceptReport(reportOf(1, { findings: below, blockingCount: 0, reviewPassed: true }), contextOf(1));

      expect(result).toEqual({
        ok: true,
        outcome: { pass: 1, reportRef: 'report@1', verdict: 'passed', blockingCount: 0, open: 3, resolved: 0, newFindings: 3, mayDispatchFix: false }
      });
    });

    it('is incomplete when none is and coverage is partial', () => {
      const ledger = ledgerOf();

      const result = ledger.acceptReport(reportOf(1, { coverage: 'partial', blockingCount: 0, reviewPassed: false }), contextOf(1));

      expect(result).toMatchObject({ ok: true, outcome: { verdict: 'incomplete', blockingCount: 0, mayDispatchFix: false } });
    });

    it('passes once every blocking finding is resolved', () => {
      const ledger = resolvedLedger();

      expect(ledger.passes().at(1)).toEqual({
        pass: 2,
        reportRef: 'report@2',
        verdict: 'passed',
        blockingCount: 0,
        open: 0,
        resolved: 1,
        newFindings: 0,
        mayDispatchFix: false
      });
    });

    it('lets no fix be dispatched on the last pass', () => {
      const ledger = openedLedger(2);

      const last = ledger.acceptReport(reportOf(2, { blockingCount: 1 }), contextOf(2));

      expect(ledger.passes().at(0)?.mayDispatchFix).toBe(true);
      expect(last).toMatchObject({ ok: true, outcome: { verdict: 'needs-fixes', mayDispatchFix: false } });
    });
  });

  describe('status transitions', () => {
    it.each<[string, FindingStatus, FindingStatus, number]>([
      ['open stays open', 'open', 'open', 1],
      ['open becomes unresolved', 'unresolved', 'unresolved', 1],
      ['open becomes resolved', 'resolved', 'resolved', 0]
    ])('%s', (_label, disposition, status, blockingCount) => {
      const ledger = openedLedger();

      accept(ledger, 2, { dispositions: [{ findingId: 'F-1', status: disposition }], blockingCount, reviewPassed: blockingCount === 0 });

      expect(statusOf(ledger, 'F-1')).toBe(status);
    });

    it.each<[string, FindingStatus, FindingStatus, number]>([
      ['unresolved stays unresolved on open', 'open', 'unresolved', 1],
      ['unresolved stays unresolved', 'unresolved', 'unresolved', 1],
      ['unresolved becomes resolved', 'resolved', 'resolved', 0]
    ])('%s', (_label, disposition, status, blockingCount) => {
      const ledger = openedLedger();
      accept(ledger, 2, { dispositions: [{ findingId: 'F-1', status: 'unresolved' }], blockingCount: 1 });

      accept(ledger, 3, { dispositions: [{ findingId: 'F-1', status: disposition }], blockingCount, reviewPassed: blockingCount === 0 });

      expect(statusOf(ledger, 'F-1')).toBe(status);
    });

    it.each<[string, FindingStatus, FindingStatus, number]>([
      ['reopened stays reopened on open', 'open', 'reopened', 1],
      ['reopened becomes unresolved', 'unresolved', 'unresolved', 1],
      ['reopened becomes resolved', 'resolved', 'resolved', 0]
    ])('%s', (_label, disposition, status, blockingCount) => {
      const ledger = resolvedLedger();
      accept(ledger, 3, { dispositions: [{ findingId: 'F-1', status: 'reopened' }], blockingCount: 1 });

      accept(ledger, 4, { dispositions: [{ findingId: 'F-1', status: disposition }], blockingCount, reviewPassed: blockingCount === 0 });

      expect(statusOf(ledger, 'F-1')).toBe(status);
    });

    it('leaves a resolved finding resolved, and writes no history for an unchanged status', () => {
      const ledger = resolvedLedger();

      accept(ledger, 3, { dispositions: [{ findingId: 'F-1', status: 'resolved' }], blockingCount: 0, reviewPassed: true });

      expect(ledger.findings().at(0)?.history).toEqual([
        { pass: 1, status: 'open' },
        { pass: 2, status: 'resolved' }
      ]);
    });

    it('leaves a finding the report does not mention as it was', () => {
      const ledger = resolvedLedger();

      accept(ledger, 3, { findings: [finding({ id: 'F-2' })], blockingCount: 1 });

      expect(statusOf(ledger, 'F-1')).toBe('resolved');
      expect(statusOf(ledger, 'F-2')).toBe('open');
      expect(ledger.findings().at(1)?.openedInPass).toBe(3);
    });

    it.each<[string, FindingStatus]>([
      ['open', 'open'],
      ['unresolved', 'unresolved']
    ])('refuses %s on a resolved finding: a recurrence must be reopened', (_label, status) => {
      const ledger = resolvedLedger();
      const before = stateOf(ledger);

      const result = ledger.acceptReport(reportOf(3, { dispositions: [{ findingId: 'F-1', status }], blockingCount: 1 }), contextOf(3));

      expect(result).toEqual(refusal('invalid-source', 'recurrence-not-reopened'));
      expect(stateOf(ledger)).toBe(before);
    });

    it('refuses reopened on a finding that is not resolved: nothing to reopen', () => {
      const ledger = openedLedger();
      const before = stateOf(ledger);

      const result = ledger.acceptReport(reportOf(2, { dispositions: [{ findingId: 'F-1', status: 'reopened' }], blockingCount: 1 }), contextOf(2));

      expect(result).toEqual(refusal('invalid-source', 'reopen-not-resolved'));
      expect(stateOf(ledger)).toBe(before);
    });

    it('refuses reopened on an unresolved finding and on a reopened one', () => {
      const unresolved = openedLedger();
      accept(unresolved, 2, { dispositions: [{ findingId: 'F-1', status: 'unresolved' }], blockingCount: 1 });
      const reopened = resolvedLedger();
      accept(reopened, 3, { dispositions: [{ findingId: 'F-1', status: 'reopened' }], blockingCount: 1 });

      expect(unresolved.acceptReport(reportOf(3, { dispositions: [{ findingId: 'F-1', status: 'reopened' }], blockingCount: 1 }), contextOf(3))).toEqual(
        refusal('invalid-source', 'reopen-not-resolved')
      );
      expect(reopened.acceptReport(reportOf(4, { dispositions: [{ findingId: 'F-1', status: 'reopened' }], blockingCount: 1 }), contextOf(4))).toEqual(
        refusal('invalid-source', 'reopen-not-resolved')
      );
    });
  });

  describe('refusals', () => {
    it('refuses a report for another loop', () => {
      const ledger = ledgerOf();

      expect(ledger.acceptReport(reportOf(1, { loopId: 'loop-2' }), contextOf(1))).toEqual(refusal('invalid-source', 'loop-mismatch'));
    });

    it('refuses a report reference that is not one', () => {
      const ledger = ledgerOf();

      expect(ledger.acceptReport(reportOf(1), contextOf(1, { reportRef: 'report 1' }))).toEqual(refusal('invalid-source', 'report-ref'));
      expect(ledger.acceptReport(reportOf(1), contextOf(1, { reportRef: textOfBytes(257) }))).toEqual(refusal('invalid-source', 'report-ref'));
    });

    it('refuses a pass that is not the last pass plus one', () => {
      const fresh = ledgerOf();
      const ledger = openedLedger();
      const before = stateOf(ledger);

      expect(fresh.acceptReport(reportOf(2), contextOf(2))).toEqual(refusal('stale-revision', 'pass-out-of-order'));
      expect(ledger.acceptReport(reportOf(3, { blockingCount: 1 }), contextOf(3))).toEqual(refusal('stale-revision', 'pass-out-of-order'));
      expect(ledger.acceptReport(reportOf(1, { blockingCount: 1 }), contextOf(1, { reportRef: 'report@1b' }))).toEqual(
        refusal('stale-revision', 'pass-out-of-order')
      );
      expect(stateOf(ledger)).toBe(before);
    });

    it('returns the earlier outcome when the same report is given again, and changes nothing', () => {
      const ledger = ledgerOf();
      const report = reportOf(1, { findings: [finding()], blockingCount: 1 });
      const first = ledger.acceptReport(report, contextOf(1));
      const before = stateOf(ledger);

      expect(ledger.acceptReport(report, contextOf(1))).toEqual(first);
      expect(stateOf(ledger)).toBe(before);
    });

    it('refuses another report under the reference of an accepted one', () => {
      const ledger = openedLedger();
      const before = stateOf(ledger);
      const other = reportOf(1, { findings: [finding({ id: 'F-9' })], blockingCount: 1 });

      expect(ledger.acceptReport(other, contextOf(1))).toEqual(refusal('stale-revision', 'pass-out-of-order'));
      expect(stateOf(ledger)).toBe(before);
    });

    it('refuses a pass past the limit', () => {
      const ledger = openedLedger(2);
      accept(ledger, 2, { blockingCount: 1 });
      const before = stateOf(ledger);

      expect(ledger.acceptReport(reportOf(3, { blockingCount: 1 }), contextOf(3))).toEqual(refusal('capacity-exceeded', 'pass-limit'));
      expect(stateOf(ledger)).toBe(before);
    });

    it.each([
      ['another candidate', { candidateRef: 'candidate@2' }, 'candidate-mismatch'],
      ['another scope revision', { scopeRevision: 'scope@2' }, 'scope-mismatch'],
      ['another criteria revision', { criteriaRevision: 'criteria@2' }, 'criteria-mismatch']
    ])('refuses a report made for %s (scenario 6)', (_label, overrides, detail) => {
      const ledger = ledgerOf();

      expect(ledger.acceptReport(reportOf(1, overrides), contextOf(1))).toEqual(refusal('stale-revision', detail));
      expect(ledger.acceptReport(reportOf(1), contextOf(1, overrides))).toEqual(refusal('stale-revision', detail));
      expect(ledger.passes()).toEqual([]);
    });

    it('accepts a report for the candidate of its own pass', () => {
      const ledger = openedLedger();
      const report = reportOf(2, { candidateRef: 'candidate@2', dispositions: [{ findingId: 'F-1', status: 'resolved' }], blockingCount: 0, reviewPassed: true });

      expect(ledger.acceptReport(report, contextOf(2, { candidateRef: 'candidate@2' })).ok).toBe(true);
    });

    it('refuses a report whose coverage is unavailable, whatever it says it found (scenario 6)', () => {
      const ledger = ledgerOf();
      const report = reportOf(1, { coverage: 'unavailable', findings: [finding()], blockingCount: 1 });

      expect(ledger.acceptReport(report, contextOf(1))).toEqual(refusal('required-context-unavailable', 'coverage-unavailable'));
      expect(ledger.acceptReport(reportOf(1, { coverage: 'unavailable', blockingCount: 0, reviewPassed: true }), contextOf(1))).toEqual(
        refusal('required-context-unavailable', 'coverage-unavailable')
      );
      expect(ledger.findings()).toEqual([]);
      expect(ledger.passes()).toEqual([]);
    });

    it('refuses a report that does not follow the last accepted report', () => {
      const fresh = ledgerOf();
      const ledger = openedLedger();
      const before = stateOf(ledger);

      expect(fresh.acceptReport(reportOf(1, { previousReportRef: 'report@0' }), contextOf(1))).toEqual(refusal('stale-revision', 'previous-report'));
      expect(ledger.acceptReport(reportOf(2, { previousReportRef: null, blockingCount: 1 }), contextOf(2))).toEqual(
        refusal('stale-revision', 'previous-report')
      );
      expect(ledger.acceptReport(reportOf(2, { previousReportRef: 'report@9', blockingCount: 1 }), contextOf(2))).toEqual(
        refusal('stale-revision', 'previous-report')
      );
      expect(stateOf(ledger)).toBe(before);
    });

    it('refuses a new finding whose identity is known, open or resolved', () => {
      const open = openedLedger();
      const resolved = resolvedLedger();
      const before = stateOf(resolved);

      expect(open.acceptReport(reportOf(2, { findings: [finding()], blockingCount: 1 }), contextOf(2))).toEqual(refusal('invalid-source', 'finding-known'));
      expect(resolved.acceptReport(reportOf(3, { findings: [finding()], blockingCount: 1 }), contextOf(3))).toEqual(
        refusal('invalid-source', 'finding-known')
      );
      expect(stateOf(resolved)).toBe(before);
    });

    it('refuses two new findings with one identity', () => {
      const ledger = ledgerOf();
      const twice = [finding(), finding({ id: 'F-2' }), finding({ severity: 'low' })];

      expect(ledger.acceptReport(reportOf(1, { findings: twice, blockingCount: 2 }), contextOf(1))).toEqual(refusal('invalid-source', 'finding-duplicate'));
      expect(ledger.findings()).toEqual([]);
    });

    it('refuses a disposition for an unknown finding, one opened by the same report included', () => {
      const ledger = openedLedger();
      const before = stateOf(ledger);
      const sameReport = reportOf(2, { findings: [finding({ id: 'F-2' })], dispositions: [{ findingId: 'F-2', status: 'open' }], blockingCount: 2 });

      expect(ledger.acceptReport(reportOf(2, { dispositions: [{ findingId: 'F-9', status: 'open' }], blockingCount: 1 }), contextOf(2))).toEqual(
        refusal('invalid-source', 'disposition-unknown')
      );
      expect(ledger.acceptReport(sameReport, contextOf(2))).toEqual(refusal('invalid-source', 'disposition-unknown'));
      expect(stateOf(ledger)).toBe(before);
    });

    it('refuses two dispositions for one finding', () => {
      const ledger = openedLedger();
      const twice = [
        { findingId: 'F-1', status: 'open' as const },
        { findingId: 'F-1', status: 'resolved' as const }
      ];

      expect(ledger.acceptReport(reportOf(2, { dispositions: twice, blockingCount: 0, reviewPassed: true }), contextOf(2))).toEqual(
        refusal('invalid-source', 'disposition-duplicate')
      );
      expect(statusOf(ledger, 'F-1')).toBe('open');
    });

    it('holds 1,024 findings in a loop and refuses one more', () => {
      const ledger = ledgerOf(8);
      for (const pass of [1, 2, 3, 4, 5]) {
        accept(ledger, pass, { findings: manyFindings(200, `P${String(pass)}`), blockingCount: 0, reviewPassed: true });
      }
      const before = stateOf(ledger);

      expect(ledger.acceptReport(reportOf(6, { findings: manyFindings(25, 'P6'), blockingCount: 0, reviewPassed: true }), contextOf(6))).toEqual(
        refusal('capacity-exceeded', 'finding-count')
      );
      expect(stateOf(ledger)).toBe(before);
      expect(ledger.acceptReport(reportOf(6, { findings: manyFindings(24, 'P6'), blockingCount: 0, reviewPassed: true }), contextOf(6)).ok).toBe(true);
      expect(ledger.findings()).toHaveLength(1_024);
    });

    it('applies a report whole or not at all', () => {
      const ledger = openedLedger();
      const before = stateOf(ledger);
      const report = reportOf(2, {
        findings: [finding({ id: 'F-2' })],
        dispositions: [
          { findingId: 'F-1', status: 'resolved' },
          { findingId: 'F-9', status: 'open' }
        ],
        blockingCount: 1
      });

      expect(ledger.acceptReport(report, contextOf(2)).ok).toBe(false);
      expect(stateOf(ledger)).toBe(before);
    });
  });

  it('keeps no title and no explanation of a finding', () => {
    const ledger = ledgerOf();
    accept(ledger, 1, { findings: [finding({ title: marker('title'), explanation: marker('explanation') })], blockingCount: 1 });

    expect(stateOf(ledger)).not.toContain('SEEDED');
  });

  it('gives copies: a change to a returned list changes no record', () => {
    const ledger = openedLedger();
    const listed = ledger.findings() as unknown as { status: string; history: unknown[] }[];
    const passes = ledger.passes() as unknown[];

    listed.at(0)?.history.pop();
    listed.pop();
    passes.pop();

    expect(ledger.findings()).toEqual([
      { id: 'F-1', severity: 'high', status: 'open', openedInPass: 1, history: [{ pass: 1, status: 'open' }], claims: [] }
    ]);
    expect(ledger.passes()).toHaveLength(1);
  });

  it('is not changed by a later change to an accepted report', () => {
    const ledger = ledgerOf();
    const report = reportOf(1, { findings: [finding()], blockingCount: 1 });
    ledger.acceptReport(report, contextOf(1));
    const before = stateOf(ledger);

    (report.findings as NewFinding[]).pop();

    expect(stateOf(ledger)).toBe(before);
  });
});

describe('recordClaims', () => {
  const candidate = { candidateRef: 'candidate@1' };

  function claimsOf(overrides: Partial<FixClaims> = {}): FixClaims {
    return fixClaims(overrides);
  }

  it('records a claim beside the status and changes no status (scenario 2)', () => {
    const ledger = ledgerOf();
    accept(ledger, 1, { findings: [finding(), finding({ id: 'F-2', severity: 'critical' })], blockingCount: 2 });
    const set = claimsOf({
      claims: [
        { findingId: 'F-1', claim: 'claimed-fixed' },
        { findingId: 'F-2', claim: 'disputed' }
      ]
    });

    expect(ledger.recordClaims(set, candidate)).toEqual({ ok: true, recorded: 2 });
    expect(ledger.findings()).toEqual([
      { id: 'F-1', severity: 'high', status: 'open', openedInPass: 1, history: [{ pass: 1, status: 'open' }], claims: [{ pass: 1, claim: 'claimed-fixed' }] },
      { id: 'F-2', severity: 'critical', status: 'open', openedInPass: 1, history: [{ pass: 1, status: 'open' }], claims: [{ pass: 1, claim: 'disputed' }] }
    ]);
    expect(ledger.passes()).toHaveLength(1);
  });

  it('leaves the next report to decide: a claimed fix does not resolve a finding', () => {
    const ledger = openedLedger();
    ledger.recordClaims(claimsOf(), candidate);

    expect(ledger.acceptReport(reportOf(2, { reviewPassed: true, blockingCount: 0 }), contextOf(2))).toEqual(
      refusal('invalid-source', 'verdict-mismatch')
    );
    expect(statusOf(ledger, 'F-1')).toBe('open');
  });

  it('keeps the claims of each pass in order', () => {
    const ledger = openedLedger();
    ledger.recordClaims(claimsOf({ claims: [{ findingId: 'F-1', claim: 'not-addressed' }] }), candidate);
    accept(ledger, 2, { blockingCount: 1 });

    const second = ledger.recordClaims(claimsOf({ pass: 2, basedOnReportRef: 'report@2' }), candidate);

    expect(second).toEqual({ ok: true, recorded: 1 });
    expect(ledger.findings().at(0)?.claims).toEqual([
      { pass: 1, claim: 'not-addressed' },
      { pass: 2, claim: 'claimed-fixed' }
    ]);
  });

  it('records an equal claim set once', () => {
    const ledger = openedLedger();
    ledger.recordClaims(claimsOf(), candidate);

    expect(ledger.recordClaims(claimsOf(), candidate)).toEqual({ ok: true, recorded: 0 });
    expect(ledger.findings().at(0)?.claims).toEqual([{ pass: 1, claim: 'claimed-fixed' }]);
  });

  it('records a set with no claim', () => {
    const ledger = openedLedger();

    expect(ledger.recordClaims(claimsOf({ claims: [] }), candidate)).toEqual({ ok: true, recorded: 0 });
  });

  it('refuses another claim for a finding in the same pass', () => {
    const ledger = openedLedger();
    ledger.recordClaims(claimsOf(), candidate);
    const before = stateOf(ledger);

    expect(ledger.recordClaims(claimsOf({ claims: [{ findingId: 'F-1', claim: 'disputed' }] }), candidate)).toEqual(
      refusal('invalid-source', 'claim-conflict')
    );
    expect(stateOf(ledger)).toBe(before);
  });

  it.each([
    ['a claim set for another loop', { loopId: 'loop-2' }, candidate, 'invalid-source', 'loop-mismatch'],
    ['a claim set based on another report', { basedOnReportRef: 'report@0' }, candidate, 'stale-revision', 'claims-basis'],
    ['a claim set made for another candidate', {}, { candidateRef: 'candidate@2' }, 'stale-revision', 'candidate-mismatch'],
    ['a claim set of another pass', { pass: 2 }, candidate, 'stale-revision', 'claims-pass'],
    ['a claim for an unknown finding', { claims: [{ findingId: 'F-9', claim: 'disputed' as const }] }, candidate, 'invalid-source', 'claim-unknown'],
    [
      'two claims for one finding',
      { claims: [{ findingId: 'F-1', claim: 'disputed' as const }, { findingId: 'F-1', claim: 'disputed' as const }] },
      candidate,
      'invalid-source',
      'claim-duplicate'
    ]
  ])('refuses %s', (_label, overrides, context, failure, detail) => {
    const ledger = openedLedger();
    const before = stateOf(ledger);

    expect(ledger.recordClaims(claimsOf(overrides), context)).toEqual(refusal(failure, detail));
    expect(stateOf(ledger)).toBe(before);
  });

  it('refuses a claim set before any report is accepted', () => {
    const ledger = ledgerOf();

    expect(ledger.recordClaims(claimsOf(), candidate)).toEqual(refusal('stale-revision', 'claims-basis'));
  });

  it('refuses a claim set based on a report that is no longer the last', () => {
    const ledger = openedLedger();
    accept(ledger, 2, { blockingCount: 1 });

    expect(ledger.recordClaims(claimsOf(), candidate)).toEqual(refusal('stale-revision', 'claims-basis'));
  });

  it('records a claim set whole or not at all', () => {
    const ledger = openedLedger();
    const set = claimsOf({
      claims: [
        { findingId: 'F-1', claim: 'claimed-fixed' },
        { findingId: 'F-9', claim: 'claimed-fixed' }
      ]
    });

    expect(ledger.recordClaims(set, candidate)).toEqual(refusal('invalid-source', 'claim-unknown'));
    expect(ledger.findings().at(0)?.claims).toEqual([]);
  });

  it('takes a claim on a resolved finding and leaves it resolved', () => {
    const ledger = resolvedLedger();

    expect(ledger.recordClaims(claimsOf({ pass: 2, basedOnReportRef: 'report@2', claims: [{ findingId: 'F-1', claim: 'disputed' }] }), candidate)).toEqual({
      ok: true,
      recorded: 1
    });
    expect(statusOf(ledger, 'F-1')).toBe('resolved');
  });
});
