import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PhaseRetryEvaluator } from '../../../src/controller/phase-retry-evaluator';
import type { PhaseRetryEvaluatorInputs } from '../../../src/controller/phase-retry-evaluator';
import { PhaseRunner } from '../../../src/controller/phase-runner';
import { PromptBuilder } from '../../../src/runner/prompt-builder';
import { SanitizedLogger } from '../../../src/lib/logger';
import type { AuditLogWriter } from '../../../src/audit/audit-log-writer';
import type { AuditEntry } from '../../../src/audit/audit-entry';
import type { ClaudeCliRunner } from '../../../src/runner/claude-cli';
import type { InvocationResult } from '../../../src/parser/stdout-parser';
import type { PhaseDef } from '../../../src/config/pipeline-config';

interface AppendedEvent {
  eventType: string;
  payload: Record<string, unknown>;
  outcome: string;
}

function makeAuditWriter(): { writer: AuditLogWriter; appends: AppendedEvent[] } {
  const appends: AppendedEvent[] = [];
  let counter = 0;
  const writer = {
    append: vi.fn(async (entry: Omit<AuditEntry, 'id' | 'timestamp'>): Promise<AuditEntry> => {
      appends.push({
        eventType: entry.eventType,
        payload: entry.payload as Record<string, unknown>,
        outcome: entry.outcome
      });
      return {
        id: `audit-${++counter}`,
        timestamp: '2026-05-19T00:00:00Z',
        ...entry
      } as AuditEntry;
    }),
    logPath: '/tmp/.schegent/audit.log'
  } as unknown as AuditLogWriter;
  return { writer, appends };
}

/**
 * The nth appended payload, and a thrown failure if there is no nth event.
 *
 * Not `appends[n].payload`. Many assertions below are `not.toHaveProperty('stalled')`,
 * which PASSES on `undefined` — an index past the end would report the field absent
 * from an event nobody appended, which is the same green as the behaviour being
 * correct. `.at()` is the read whose type admits the miss (FR-R3-110's
 * `noUncheckedIndexedAccess` ratchet counts the unchecked form) and the throw turns
 * it into a failure that names the index.
 *
 * A negative index reads from the end, as `Array.prototype.at` does.
 */
function payloadAt(appends: readonly AppendedEvent[], index: number): Record<string, unknown> {
  const event = appends.at(index);
  if (event === undefined) throw new Error(`no appended event at index ${index}`);
  return event.payload;
}

const baseInputs = (overrides?: Partial<PhaseRetryEvaluatorInputs>): PhaseRetryEvaluatorInputs => ({
  phase: 'speckit-specify',
  phaseDef: undefined,
  pipelineId: 'speckit-new-feature',
  runId: 'run-1',
  iteration: 1,
  result: { kind: 'clean', auditEntry: {} as never } as InvocationResult,
  metrics: {},
  ...overrides
});

const phaseDefWithCondition = (condition: string, id = 'speckit-specify'): PhaseDef => ({
  id,
  ruleset: 'speckit',
  iterationCap: 1,
  retryCondition: condition
} as unknown as PhaseDef);

describe('PhaseRetryEvaluator.maybeEmit', () => {
  let logger: SanitizedLogger;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logger = new SanitizedLogger();
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });

  it('emits nothing when retryCondition is undefined', async () => {
    const { writer, appends } = makeAuditWriter();
    const evaluator = new PhaseRetryEvaluator(writer, logger);
    await evaluator.maybeEmit(baseInputs());
    expect(appends).toHaveLength(0);
  });

  it('emits nothing when retryCondition is whitespace-only', async () => {
    const { writer, appends } = makeAuditWriter();
    const evaluator = new PhaseRetryEvaluator(writer, logger);
    await evaluator.maybeEmit(
      baseInputs({ phaseDef: phaseDefWithCondition('   ') })
    );
    expect(appends).toHaveLength(0);
  });

  it('skips emission when result.kind is malformed', async () => {
    const { writer, appends } = makeAuditWriter();
    const evaluator = new PhaseRetryEvaluator(writer, logger);
    await evaluator.maybeEmit(
      baseInputs({
        phaseDef: phaseDefWithCondition('issues > 0'),
        result: { kind: 'malformed', warnings: [], auditEntry: null } as InvocationResult
      })
    );
    expect(appends).toHaveLength(0);
  });

  it('skips emission when result.kind is transient_error', async () => {
    const { writer, appends } = makeAuditWriter();
    const evaluator = new PhaseRetryEvaluator(writer, logger);
    await evaluator.maybeEmit(
      baseInputs({
        phaseDef: phaseDefWithCondition('issues > 0'),
        result: { kind: 'transient_error', warnings: [], auditEntry: null } as unknown as InvocationResult
      })
    );
    expect(appends).toHaveLength(0);
  });

  it('skips emission when result.kind is rate_limited', async () => {
    const { writer, appends } = makeAuditWriter();
    const evaluator = new PhaseRetryEvaluator(writer, logger);
    await evaluator.maybeEmit(
      baseInputs({
        phaseDef: phaseDefWithCondition('issues > 0'),
        result: { kind: 'rate_limited', warnings: [], auditEntry: null } as unknown as InvocationResult
      })
    );
    expect(appends).toHaveLength(0);
  });

  it('emits with evaluationError=true on parse error and logs warn with phase-runner string', async () => {
    const { writer, appends } = makeAuditWriter();
    const fakeValidate = vi.fn(() => ({ ok: false as const, error: 'parse failure xyz' }));
    const fakeEvaluate = vi.fn();
    const evaluator = new PhaseRetryEvaluator(
      writer,
      logger,
      fakeValidate as never,
      fakeEvaluate as never
    );
    await evaluator.maybeEmit(
      baseInputs({ phaseDef: phaseDefWithCondition('@bad@') })
    );
    expect(appends).toHaveLength(1);
    expect(appends[0].eventType).toBe('phase.retry_evaluated');
    expect(appends[0].outcome).toBe('info');
    expect(appends[0].payload.decision).toBe(false);
    expect(appends[0].payload.evaluationError).toBe(true);
    expect(appends[0].payload.errorMessage).toBe('parse failure xyz');
    expect(warnSpy).toHaveBeenCalledWith(
      'retryCondition parse error on speckit-specify: parse failure xyz'
    );
    expect(fakeEvaluate).not.toHaveBeenCalled();
  });

  it('emits with evaluationError=true on evaluation error and logs warn with phase-runner string', async () => {
    const { writer, appends } = makeAuditWriter();
    const parsedExpr = { __sentinel__: 'expr' } as unknown;
    const fakeValidate = vi.fn(() => ({ ok: true as const, expression: parsedExpr }));
    const fakeEvaluate = vi.fn(() => ({
      ok: false as const,
      error: { error: 'div-by-zero' }
    }));
    const evaluator = new PhaseRetryEvaluator(
      writer,
      logger,
      fakeValidate as never,
      fakeEvaluate as never
    );
    await evaluator.maybeEmit(
      baseInputs({ phaseDef: phaseDefWithCondition('issues / 0') })
    );
    expect(appends).toHaveLength(1);
    expect(appends[0].payload.decision).toBe(false);
    expect(appends[0].payload.evaluationError).toBe(true);
    expect(appends[0].payload.errorMessage).toBe('div-by-zero');
    expect(warnSpy).toHaveBeenCalledWith(
      'retryCondition evaluation error on speckit-specify: div-by-zero'
    );
  });

  it('emits success with decision=true and no missingKeys when evaluation succeeds', async () => {
    const { writer, appends } = makeAuditWriter();
    const fakeValidate = vi.fn(() => ({ ok: true as const, expression: { __sentinel__: 'expr' } }));
    const fakeEvaluate = vi.fn(() => ({
      ok: true as const,
      evaluation: { value: true, missingKeys: [] as string[] }
    }));
    const evaluator = new PhaseRetryEvaluator(
      writer,
      logger,
      fakeValidate as never,
      fakeEvaluate as never
    );
    await evaluator.maybeEmit(
      baseInputs({
        phaseDef: phaseDefWithCondition('issues > 0'),
        metrics: { issues: 3 }
      })
    );
    expect(appends).toHaveLength(1);
    expect(appends[0].payload.decision).toBe(true);
    expect(appends[0].payload.evaluationError).toBeUndefined();
    // FR-028 (BUG-001): missingKeys is always emitted; empty array means
    // "no missing keys" (distinct from omitted/legacy).
    expect(appends[0].payload.missingKeys).toEqual([]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('emits success with decision=false and no missingKeys when evaluation returns false', async () => {
    const { writer, appends } = makeAuditWriter();
    const fakeValidate = vi.fn(() => ({ ok: true as const, expression: {} }));
    const fakeEvaluate = vi.fn(() => ({
      ok: true as const,
      evaluation: { value: false, missingKeys: [] as string[] }
    }));
    const evaluator = new PhaseRetryEvaluator(
      writer,
      logger,
      fakeValidate as never,
      fakeEvaluate as never
    );
    await evaluator.maybeEmit(
      baseInputs({ phaseDef: phaseDefWithCondition('issues > 0') })
    );
    expect(appends).toHaveLength(1);
    expect(appends[0].payload.decision).toBe(false);
    // FR-028 (BUG-001): missingKeys is always emitted; empty array means
    // "no missing keys" (distinct from omitted/legacy).
    expect(appends[0].payload.missingKeys).toEqual([]);
  });

  it('populates missingKeys on payload and logs warning when evaluation flags missing metrics', async () => {
    const { writer, appends } = makeAuditWriter();
    const fakeValidate = vi.fn(() => ({ ok: true as const, expression: {} }));
    const fakeEvaluate = vi.fn(() => ({
      ok: true as const,
      evaluation: { value: false, missingKeys: ['issues', 'lint_failures'] }
    }));
    const evaluator = new PhaseRetryEvaluator(
      writer,
      logger,
      fakeValidate as never,
      fakeEvaluate as never
    );
    await evaluator.maybeEmit(
      baseInputs({
        phaseDef: phaseDefWithCondition('issues > 0 || lint_failures > 0')
      })
    );
    expect(appends).toHaveLength(1);
    expect(appends[0].payload.decision).toBe(false);
    expect(appends[0].payload.missingKeys).toEqual(['issues', 'lint_failures']);
    // FR-012 + FR-029 (BUG-001): canonical WARN text includes the missing
    // keys, the prompt diagnostic hint, the sub-block enumeration, and the
    // FR-007 cross-reference.
    expect(warnSpy).toHaveBeenCalledWith(
      'retryCondition missing metric(s) on speckit-specify: issues, lint_failures — ' +
        'phase prompt may not be emitting these keys, or they appeared inside a ' +
        'sub-block (Notes:/Findings:/Open Questions:/Remaining Issues:) without a ' +
        'trailing blank line or top-level field separator (see spec FR-007)'
    );
  });
});

// Feature 194 — FR-006 through FR-009, SC-005, SC-006, SC-007. `stalled` is
// computed against the REAL DSL (validate/evaluate), not fakes: the tracker
// compares the judged set derived from an actually-parsed condition, which is
// the thing FR-008 requires and a stubbed expression cannot exercise.
describe('PhaseRetryEvaluator — stagnation count (194, T009)', () => {
  let logger: SanitizedLogger;

  beforeEach(() => {
    logger = new SanitizedLogger();
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });

  it('rises to 9 over ten iterations with an identical judged metrics map', async () => {
    const { writer, appends } = makeAuditWriter();
    const evaluator = new PhaseRetryEvaluator(writer, logger);
    const phaseDef = phaseDefWithCondition('issues > 0');
    for (let i = 1; i <= 10; i++) {
      await evaluator.maybeEmit(
        baseInputs({ phaseDef, iteration: i, metrics: { issues: 1 } })
      );
    }
    expect(appends).toHaveLength(10);
    expect(payloadAt(appends, 0).stalled).toBeUndefined();
    for (let i = 2; i <= 10; i++) {
      expect(payloadAt(appends, i - 1).stalled, `iteration ${i}`).toBe(i - 1);
    }
  });

  it('restarts the count at the iteration a condition-referenced metric changes', async () => {
    const { writer, appends } = makeAuditWriter();
    const evaluator = new PhaseRetryEvaluator(writer, logger);
    const phaseDef = phaseDefWithCondition('issues > 0');
    const issuesAt = (iteration: number) => (iteration >= 5 ? 2 : 1);
    for (let i = 1; i <= 10; i++) {
      await evaluator.maybeEmit(
        baseInputs({ phaseDef, iteration: i, metrics: { issues: issuesAt(i) } })
      );
    }
    // 1: first comparable, no stalled. 2,3,4: rising 1,2,3. 5: changed, no
    // stalled (proves the value is not the iteration number). 6..10: rising
    // 1..5 again from the new baseline.
    const stalledByIteration = appends.map((a) => a.payload.stalled);
    expect(stalledByIteration).toEqual([
      undefined,
      1,
      2,
      3,
      undefined,
      1,
      2,
      3,
      4,
      5
    ]);
  });

  it('an unreferenced metric that changes every iteration has no effect on the count (FR-007, SC-006)', async () => {
    const { writer, appends } = makeAuditWriter();
    const evaluator = new PhaseRetryEvaluator(writer, logger);
    const phaseDef = phaseDefWithCondition('issues > 0');
    for (let i = 1; i <= 10; i++) {
      // `noise` is not referenced by the condition and changes every call.
      await evaluator.maybeEmit(
        baseInputs({ phaseDef, iteration: i, metrics: { issues: 1, noise: i * 7 } })
      );
    }
    const stalledByIteration = appends.map((a) => a.payload.stalled);
    // Identical to the fully-frozen run above: 9 unchanged comparisons.
    expect(stalledByIteration).toEqual([undefined, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});

describe('PhaseRetryEvaluator — stagnation negative cases (194, T010, contract C2.1)', () => {
  let logger: SanitizedLogger;

  beforeEach(() => {
    logger = new SanitizedLogger();
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });

  it('emits no stalled on the first comparable iteration', async () => {
    const { writer, appends } = makeAuditWriter();
    const evaluator = new PhaseRetryEvaluator(writer, logger);
    await evaluator.maybeEmit(
      baseInputs({ phaseDef: phaseDefWithCondition('issues > 0'), metrics: { issues: 1 } })
    );
    expect(appends).toHaveLength(1);
    expect(payloadAt(appends, 0)).not.toHaveProperty('stalled');
  });

  it('emits no stalled for a falsy iteration, and leaves the retained figures for the eviction the driver performs', async () => {
    const { writer, appends } = makeAuditWriter();
    const evaluator = new PhaseRetryEvaluator(writer, logger);
    const phaseDef = phaseDefWithCondition('issues > 0');
    // Two unchanged truthy iterations first, so a tracker entry with count=1 exists.
    await evaluator.maybeEmit(baseInputs({ phaseDef, iteration: 1, metrics: { issues: 1 } }));
    await evaluator.maybeEmit(baseInputs({ phaseDef, iteration: 2, metrics: { issues: 1 } }));
    expect(payloadAt(appends, 1).stalled).toBe(1);
    // Falsy iteration: condition goes false. No stalled reported for it.
    await evaluator.maybeEmit(baseInputs({ phaseDef, iteration: 3, metrics: { issues: 0 } }));
    expect(payloadAt(appends, 2)).not.toHaveProperty('stalled');

    // This test was previously NAMED for "never resumes a stale count on the
    // next truthy iteration" and stopped one line above, so it asserted nothing
    // of the sort — and the evaluator alone does resume. Pinning both halves
    // records WHERE the guarantee lives: a falsy decision is an ADVANCE, and
    // `PostPhaseDecision.evictStagnationTracker` is true on advance, so the
    // driver clears the pair before a later iteration can reach this snapshot.
    expect(evaluator.retainedStagnationKeyCount).toBe(1);
    await evaluator.maybeEmit(baseInputs({ phaseDef, iteration: 4, metrics: { issues: 1 } }));
    expect(payloadAt(appends, 3).stalled).toBe(2);

    // With that eviction, it does not resume.
    evaluator.evictStagnationTracker('run-1', 'speckit-specify');
    await evaluator.maybeEmit(baseInputs({ phaseDef, iteration: 5, metrics: { issues: 1 } }));
    expect(payloadAt(appends, 4)).not.toHaveProperty('stalled');
  });

  it('emits no stalled when evaluation errors, over a condition that does reference figures', async () => {
    // 2026-09-04 review: this test used to fake `validate` too, returning the
    // sentinel `{ __sentinel__: 'expr' }` as the AST. `referencedIdentifiers()`
    // walks by `kind`, so that object yields NO identifiers — the judged set was
    // empty, and the empty-set rule (its own test below) suppressed `stalled`
    // whether or not the evaluation error did. It also emitted once, and a first
    // comparison has no predecessor, so absence was doubly guaranteed. Both
    // props are gone: the real validator parses `issues > 0` into a real AST
    // judging `issues`, and two frozen iterations mean a working evaluator WOULD
    // report a stall here — the control below shows exactly that.
    const { writer, appends } = makeAuditWriter();
    const fakeEvaluate = vi.fn(() => ({ ok: false as const, error: { error: 'boom' } }));
    const evaluator = new PhaseRetryEvaluator(writer, logger, undefined, fakeEvaluate);
    const phaseDef = phaseDefWithCondition('issues > 0');

    for (let i = 1; i <= 2; i++) {
      await evaluator.maybeEmit(baseInputs({ phaseDef, iteration: i, metrics: { issues: 1 } }));
    }

    expect(fakeEvaluate).toHaveBeenCalledTimes(2);
    expect(appends).toHaveLength(2);
    expect(appends.map((a) => a.payload.stalled)).toEqual([undefined, undefined]);
    // No baseline was recorded either. The error path deliberately leaves an
    // EXISTING entry alone (eviction is the driver's job), so the claim here is
    // narrower and is the one that matters: an iteration whose decision was
    // never computed does not itself become a snapshot a later one can match.
    expect(evaluator.retainedStagnationKeyCount).toBe(0);
  });

  it('control for the above: the same two iterations DO report a stall when evaluation succeeds', async () => {
    // Without this, "no stalled" above is unfalsifiable — it would read the same
    // against an evaluator that never emits `stalled` at all.
    const { writer, appends } = makeAuditWriter();
    const okEvaluate = vi.fn(() => ({
      ok: true as const,
      evaluation: { value: true, missingKeys: [] as readonly string[] }
    }));
    const evaluator = new PhaseRetryEvaluator(writer, logger, undefined, okEvaluate);
    const phaseDef = phaseDefWithCondition('issues > 0');

    for (let i = 1; i <= 2; i++) {
      await evaluator.maybeEmit(baseInputs({ phaseDef, iteration: i, metrics: { issues: 1 } }));
    }
    expect(appends.map((a) => a.payload.stalled)).toEqual([undefined, 1]);
  });

  it('drops the baseline on a malformed iteration rather than counting across it', async () => {
    const { writer, appends } = makeAuditWriter();
    const evaluator = new PhaseRetryEvaluator(writer, logger);
    const phaseDef = phaseDefWithCondition('issues > 0');
    // A malformed result with exit 0 and no fatal signature maps to `issues_remain`
    // (`phase-outcome-mapper.ts`), whose retryCondition is still consulted — against
    // metrics the sequencer withholds for a malformed parse — and can return `loop`.
    // No advance, halt or pause follows, so the driver's eviction never runs, and a
    // retained baseline would let iteration 3 compare against iteration 1 and report
    // a stall spanning an iteration whose figures were never compared. FR-009 permits
    // understating and forbids overstating, so the gap drops the baseline, exactly as
    // the `present === 0` branch does for the other route to an unmeasured iteration.
    await evaluator.maybeEmit(baseInputs({ phaseDef, iteration: 1, metrics: { issues: 1 } }));
    expect(evaluator.retainedStagnationKeyCount).toBe(1);
    await evaluator.maybeEmit(
      baseInputs({
        phaseDef,
        iteration: 2,
        metrics: { issues: 1 },
        result: { kind: 'malformed', warnings: [], auditEntry: null } as InvocationResult
      })
    );
    expect(evaluator.retainedStagnationKeyCount).toBe(0);
    await evaluator.maybeEmit(baseInputs({ phaseDef, iteration: 3, metrics: { issues: 1 } }));
    expect(appends).toHaveLength(2);
    expect(payloadAt(appends, 1)).not.toHaveProperty('stalled');
  });

  it('emits no stalled when the condition references no identifiers', async () => {
    const { writer, appends } = makeAuditWriter();
    const evaluator = new PhaseRetryEvaluator(writer, logger);
    const phaseDef = phaseDefWithCondition('1 > 0');
    await evaluator.maybeEmit(baseInputs({ phaseDef, iteration: 1, metrics: {} }));
    await evaluator.maybeEmit(baseInputs({ phaseDef, iteration: 2, metrics: {} }));
    expect(appends).toHaveLength(2);
    expect(payloadAt(appends, 0)).not.toHaveProperty('stalled');
    expect(payloadAt(appends, 1)).not.toHaveProperty('stalled');
  });

  it('a judged metric named __proto__ is compared by value, not swallowed by the prototype setter', async () => {
    const { writer, appends } = makeAuditWriter();
    const evaluator = new PhaseRetryEvaluator(writer, logger);
    const phaseDef = phaseDefWithCondition('__proto__ > 0');
    // `__proto__` is an admissible metric identifier end to end: the DSL lexer's
    // IDENT_START/IDENT_CONT accept it, the audit-log parser's METRIC_IDENT_RE
    // admits it, RESERVED_METRIC_KEYS does not drop it, and `Object.fromEntries`
    // makes it a real OWN key. On a `{}` snapshot the write `snapshot[name] =`
    // hit the inherited `__proto__` setter and stored nothing, so every
    // snapshot was empty, every comparison was equal, and the count climbed
    // while the judged figure moved on every single iteration — the overstate
    // FR-009 forbids, on a run where nothing was stalling at all.
    for (const [iteration, value] of [[1, 1], [2, 2], [3, 3]] as const) {
      const metrics = Object.create(null) as Record<string, number>;
      metrics['__proto__'] = value;
      await evaluator.maybeEmit(baseInputs({ phaseDef, iteration, metrics }));
    }
    expect(appends).toHaveLength(3);
    for (const a of appends) expect(a.payload).not.toHaveProperty('stalled');
  });

  it('emits no stalled while NONE of the judged figures is measured (a condition truthy at zero)', async () => {
    const { writer, appends } = makeAuditWriter();
    const evaluator = new PhaseRetryEvaluator(writer, logger);
    // Truthy at zero, and `resolveTerm` reads a missing identifier as 0, so this
    // loops to the cap on a phase that never reports `issues`. Two empty
    // snapshots compare equal, so the count used to climb across a stretch in
    // which nothing was measured at all. `missingKeys` on the same record is the
    // signal for that case; `stalled` is not.
    const phaseDef = phaseDefWithCondition('issues < 1');
    for (let i = 1; i <= 3; i++) {
      await evaluator.maybeEmit(baseInputs({ phaseDef, iteration: i, metrics: {} }));
    }
    expect(appends).toHaveLength(3);
    for (const a of appends) expect(a.payload).not.toHaveProperty('stalled');
    expect(payloadAt(appends, 2).missingKeys).toEqual(['issues']);
    // Nothing retained either: an unmeasurable pair costs no memory (SC-007).
    expect(evaluator.retainedStagnationKeyCount).toBe(0);
  });

  it('an iteration that measures none of the judged figures drops the baseline rather than spanning the gap', async () => {
    const { writer, appends } = makeAuditWriter();
    const evaluator = new PhaseRetryEvaluator(writer, logger);
    const phaseDef = phaseDefWithCondition('issues < 1');
    const emit = (iteration: number, metrics: Record<string, number>) =>
      evaluator.maybeEmit(baseInputs({ phaseDef, iteration, metrics }));
    await emit(1, { issues: 0 });
    await emit(2, { issues: 0 });
    await emit(3, {});
    await emit(4, { issues: 0 });
    await emit(5, { issues: 0 });
    // The count restarts after the gap instead of reporting 4 at iteration 5:
    // understating a stall is permitted, claiming one across iterations nobody
    // measured is not (FR-009).
    expect(appends.map((a) => a.payload.stalled)).toEqual([
      undefined,
      1,
      undefined,
      undefined,
      1
    ]);
  });

  it('never emits a literal zero for stalled — absence and zero mean different things (C2.1)', async () => {
    const { writer, appends } = makeAuditWriter();
    const evaluator = new PhaseRetryEvaluator(writer, logger);
    const phaseDef = phaseDefWithCondition('issues > 0');
    for (let i = 1; i <= 5; i++) {
      await evaluator.maybeEmit(baseInputs({ phaseDef, iteration: i, metrics: { issues: 1 } }));
    }

    // The whole sequence, not a per-event `not.toBe(0)` (2026-09-04 review).
    // That loop was vacuous: `undefined` is not `0`, so an evaluator that
    // emitted NOTHING passed it, and so did one that emitted a count off by
    // any amount. C2.1's claim has two halves — zero is never written, and the
    // thing written instead of zero is an ABSENCE — and only the exact sequence
    // pins both: absent on the first iteration (no prior comparison exists),
    // then one count per comparison made since (C2.2).
    expect(appends.map((a) => a.payload.stalled)).toEqual([undefined, 1, 2, 3, 4]);
    for (const [index, a] of appends.entries()) {
      const stalled = a.payload.stalled;
      if (stalled === undefined) continue;
      // A present figure is a positive integer, so no rendering of it — the
      // export's guard, the warning clause, a reviewer's column — can read a
      // count out of `0`, `-1`, or `1.5`.
      expect(
        typeof stalled === 'number' && Number.isInteger(stalled) && stalled > 0,
        `stalled at index ${index} is ${String(stalled)}`
      ).toBe(true);
    }
  });
});

describe('PhaseRetryEvaluator — concurrent Runs report independent counts (194, T011, research.md R1)', () => {
  let logger: SanitizedLogger;

  beforeEach(() => {
    logger = new SanitizedLogger();
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });

  it('two Runs looping the same phase id with different metrics each report their own count', async () => {
    const { writer, appends } = makeAuditWriter();
    // ONE evaluator instance, as it is in production: PhaseRunner and its
    // single PhaseRetryEvaluator are constructed once per window and serve
    // every queue (research.md R1). A single prior-metrics field here would
    // be last-writer-wins across the two runIds below.
    const evaluator = new PhaseRetryEvaluator(writer, logger);
    const phaseDef = phaseDefWithCondition('issues > 0');

    // run-a: frozen at issues=1 for 3 iterations.
    // run-b: frozen at issues=9 for 3 iterations — same phaseId, different Run.
    for (let i = 1; i <= 3; i++) {
      await evaluator.maybeEmit(
        baseInputs({ runId: 'run-a', phaseDef, iteration: i, metrics: { issues: 1 } })
      );
      await evaluator.maybeEmit(
        baseInputs({ runId: 'run-b', phaseDef, iteration: i, metrics: { issues: 9 } })
      );
    }

    const runAEmits = appends.filter((_, idx) => idx % 2 === 0);
    const runBEmits = appends.filter((_, idx) => idx % 2 === 1);
    expect(runAEmits.map((a) => a.payload.stalled)).toEqual([undefined, 1, 2]);
    expect(runBEmits.map((a) => a.payload.stalled)).toEqual([undefined, 1, 2]);
  });

  it('the same runId visiting two different phase ids does not cross-contaminate either count', async () => {
    const { writer, appends } = makeAuditWriter();
    const evaluator = new PhaseRetryEvaluator(writer, logger);
    const phaseA = phaseDefWithCondition('issues > 0', 'phase-a');
    const phaseB = phaseDefWithCondition('issues > 0', 'phase-b');

    for (let i = 1; i <= 3; i++) {
      await evaluator.maybeEmit(
        baseInputs({ runId: 'run-x', phaseDef: phaseA, iteration: i, metrics: { issues: 1 } })
      );
      await evaluator.maybeEmit(
        baseInputs({ runId: 'run-x', phaseDef: phaseB, iteration: i, metrics: { issues: 1 } })
      );
    }

    const phaseAEmits = appends.filter((_, idx) => idx % 2 === 0);
    const phaseBEmits = appends.filter((_, idx) => idx % 2 === 1);
    expect(phaseAEmits.map((a) => a.payload.stalled)).toEqual([undefined, 1, 2]);
    expect(phaseBEmits.map((a) => a.payload.stalled)).toEqual([undefined, 1, 2]);
  });
});

// T012's OTHER half. `tests/unit/controller/phase-sequencer.test.ts` asserts the
// DECISION — that `evictStagnationTracker` is true on advance, on halt and on
// every pause path, and false on loop. Nothing asserted what the eviction then
// DOES, because every controller-level test stubs the runner as
// `{ run: vi.fn(), evictStagnationTracker: vi.fn() }`: a spy that records a call
// and drops it. So the flag was covered, the flag's consequence was not, and
// FR-009's two substantive claims — the count restarts after a resume, and the
// structure stays bounded — rested on reading the implementation.
describe('PhaseRetryEvaluator — eviction (194, T012, FR-009, SC-005, SC-007)', () => {
  let logger: SanitizedLogger;

  beforeEach(() => {
    logger = new SanitizedLogger();
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });

  it('drops the retained map, so the first comparison after a resume has no predecessor', async () => {
    const { writer, appends } = makeAuditWriter();
    const evaluator = new PhaseRetryEvaluator(writer, logger);
    const phaseDef = phaseDefWithCondition('issues > 0');
    const emit = (iteration: number) =>
      evaluator.maybeEmit(baseInputs({ phaseDef, iteration, metrics: { issues: 1 } }));

    // Iterations 1..4 with frozen figures: undefined, 1, 2, 3.
    for (let i = 1; i <= 4; i++) await emit(i);
    // The pause. In production this is RunDriver acting on
    // PostPhaseDecision.evictStagnationTracker; here it is called directly,
    // because that is the unit under test.
    evaluator.evictStagnationTracker('run-1', 'speckit-specify');
    // Iterations 5..7, figures STILL frozen at the same value. Without the
    // eviction these would read 4, 5, 6 — the count must instead restart, and
    // iteration 5 must emit nothing at all rather than a 0.
    for (let i = 5; i <= 7; i++) await emit(i);

    expect(appends.map((a) => a.payload.stalled)).toEqual([
      undefined, 1, 2, 3, // pre-pause
      undefined, 1, 2 //     post-resume, restarted
    ]);
  });

  it('understates stagnation across an interrupted run and never overstates it (SC-005)', async () => {
    // SC-005: for N unchanging iterations interrupted by a pause after J and
    // resumed, the count at the cap is N-J-1 — strictly smaller than the
    // uninterrupted N-1. Asserted as a comparison between two runs of the same
    // length rather than as a transcribed number, so the arithmetic is the
    // property under test.
    const N = 10;
    const J = 4;
    const run = async (pauseAfter: number | null): Promise<number | undefined> => {
      const { writer, appends } = makeAuditWriter();
      const evaluator = new PhaseRetryEvaluator(writer, logger);
      const phaseDef = phaseDefWithCondition('issues > 0');
      for (let i = 1; i <= N; i++) {
        await evaluator.maybeEmit(
          baseInputs({ phaseDef, iteration: i, metrics: { issues: 1 } })
        );
        if (i === pauseAfter) evaluator.evictStagnationTracker('run-1', 'speckit-specify');
      }
      return payloadAt(appends, -1).stalled as number | undefined;
    };

    const uninterrupted = await run(null);
    const interrupted = await run(J);

    expect(uninterrupted).toBe(N - 1);
    expect(interrupted).toBe(N - J - 1);
    expect(interrupted as number).toBeLessThan(uninterrupted as number);
  });

  it('evicts only the named pair, leaving a concurrent Run and a sibling phase untouched', async () => {
    const { writer, appends } = makeAuditWriter();
    const evaluator = new PhaseRetryEvaluator(writer, logger);
    const phaseA = phaseDefWithCondition('issues > 0', 'phase-a');
    const phaseB = phaseDefWithCondition('issues > 0', 'phase-b');
    const emit = (runId: string, phaseDef: PhaseDef, iteration: number) =>
      evaluator.maybeEmit(baseInputs({ runId, phaseDef, iteration, metrics: { issues: 1 } }));

    for (let i = 1; i <= 3; i++) {
      await emit('run-a', phaseA, i);
      await emit('run-a', phaseB, i);
      await emit('run-b', phaseA, i);
    }
    appends.length = 0;
    // Evict exactly one of the three live pairs.
    evaluator.evictStagnationTracker('run-a', 'phase-a');
    await emit('run-a', phaseA, 4);
    await emit('run-a', phaseB, 4);
    await emit('run-b', phaseA, 4);

    // Only (run-a, phase-a) restarts. A per-runId key would also have wiped
    // (run-a, phase-b); a shared field would have wiped all three.
    expect(appends.map((a) => a.payload.stalled)).toEqual([undefined, 3, 3]);
  });

  it('retains one figure map per looping pair regardless of iteration count, and returns to zero once all settle (SC-007)', async () => {
    const { writer } = makeAuditWriter();
    const evaluator = new PhaseRetryEvaluator(writer, logger);
    const phaseDef = phaseDefWithCondition('issues > 0');
    const emit = (runId: string, iteration: number) =>
      evaluator.maybeEmit(baseInputs({ runId, phaseDef, iteration, metrics: { issues: 1 } }));

    expect(evaluator.retainedStagnationKeyCount).toBe(0);

    // A 2-iteration run and a 100-iteration run retain the same amount: one
    // map each. This is the assertion a per-iteration history fails and an
    // identical `stalled` sequence cannot distinguish.
    for (let i = 1; i <= 2; i++) await emit('run-short', i);
    expect(evaluator.retainedStagnationKeyCount).toBe(1);

    for (let i = 1; i <= 100; i++) await emit('run-long', i);
    expect(evaluator.retainedStagnationKeyCount).toBe(2);

    // Never more than the number of pairs actively looping...
    evaluator.evictStagnationTracker('run-short', 'speckit-specify');
    expect(evaluator.retainedStagnationKeyCount).toBe(1);
    // ...and back to zero once they all settle, so retention does not grow
    // across completed loops for the life of the window.
    evaluator.evictStagnationTracker('run-long', 'speckit-specify');
    expect(evaluator.retainedStagnationKeyCount).toBe(0);
  });

  it('is a no-op for a pair that never looped, and for one already evicted', async () => {
    const { writer } = makeAuditWriter();
    const evaluator = new PhaseRetryEvaluator(writer, logger);
    const phaseDef = phaseDefWithCondition('issues > 0');

    expect(() => evaluator.evictStagnationTracker('never-ran', 'phase-a')).not.toThrow();
    expect(evaluator.retainedStagnationKeyCount).toBe(0);

    await evaluator.maybeEmit(baseInputs({ phaseDef, iteration: 1, metrics: { issues: 1 } }));
    evaluator.evictStagnationTracker('run-1', 'speckit-specify');
    // Double eviction is reachable in production: a halt that follows a pause
    // on the same phase issues the flag twice.
    expect(() => evaluator.evictStagnationTracker('run-1', 'speckit-specify')).not.toThrow();
    expect(evaluator.retainedStagnationKeyCount).toBe(0);
  });

  // The whole-Run form (2026-09-04 review). SC-007's bound rested entirely on
  // the per-phase evictions all firing: this evaluator lives for the WINDOW,
  // and `RunDriver`'s end-of-drive funnel — advertised as the unconditional
  // backstop — evicted a single key read off `run.currentPhase`, which by then
  // is the phase the Run advanced TO (or `'done'`). So the backstop deleted a
  // key nothing ever wrote, and any pair a path left behind (the optional-phase
  // failure that bypasses `PostPhaseDecision` outright) was retained until the
  // window closed. These two tests are what make the funnel's claim checkable.
  it('drops every phase of one Run and leaves a sibling Run untouched (SC-007)', async () => {
    const { writer, appends } = makeAuditWriter();
    const evaluator = new PhaseRetryEvaluator(writer, logger);
    const phaseA = phaseDefWithCondition('issues > 0', 'phase-a');
    const phaseB = phaseDefWithCondition('issues > 0', 'phase-b');
    const emit = (runId: string, phaseDef: PhaseDef, iteration: number) =>
      evaluator.maybeEmit(baseInputs({ runId, phaseDef, iteration, metrics: { issues: 1 } }));

    for (let i = 1; i <= 3; i++) {
      await emit('run-a', phaseA, i);
      await emit('run-a', phaseB, i);
      await emit('run-b', phaseA, i);
    }
    expect(evaluator.retainedStagnationKeyCount).toBe(3);
    appends.length = 0;

    evaluator.evictRunStagnationTrackers('run-a');
    // Both of run-a's pairs go — this is the difference from the per-phase form
    // above, which would have left `phase-b` retained for the window's life.
    expect(evaluator.retainedStagnationKeyCount).toBe(1);

    await emit('run-a', phaseA, 4);
    await emit('run-a', phaseB, 4);
    await emit('run-b', phaseA, 4);
    // run-b keeps counting: a Run ending is not every Run ending.
    expect(appends.map((a) => a.payload.stalled)).toEqual([undefined, undefined, 3]);

    // Iteration 4 re-armed both of run-a's pairs, so three are live again.
    evaluator.evictRunStagnationTrackers('run-b');
    expect(evaluator.retainedStagnationKeyCount).toBe(2);
    evaluator.evictRunStagnationTrackers('run-a');
    expect(evaluator.retainedStagnationKeyCount).toBe(0);
  });

  it('is a no-op for a Run that never looped, and for one already evicted', () => {
    const { writer } = makeAuditWriter();
    const evaluator = new PhaseRetryEvaluator(writer, logger);
    // Reachable in production: `drive()` returns for every Run, including one
    // whose phases all advanced first time and one already torn down by a halt.
    expect(() => evaluator.evictRunStagnationTrackers('never-ran')).not.toThrow();
    expect(() => evaluator.evictRunStagnationTrackers('never-ran')).not.toThrow();
    expect(evaluator.retainedStagnationKeyCount).toBe(0);
  });
});

// The forwarder, on a REAL `PhaseRunner` holding a REAL `PhaseRetryEvaluator`.
// `RunDriver` holds the runner, never the evaluator, so `phase-runner.ts`'s
// pass-through is the only thing standing between the driver's flag and the
// map — and every driver- and controller-level test stubs the runner as
// `{ run: vi.fn(), evictStagnationTracker: vi.fn() }`, so the arity choice
// (one method with an optional `phaseId` rather than two methods) was pinned
// nowhere: a forwarder that routed BOTH calls to the per-phase form passed the
// entire suite while reinstating the leak this review fixed.
describe('PhaseRunner.evictStagnationTracker — routes by arity (194, SC-007)', () => {
  // The spies below are on `PhaseRetryEvaluator.prototype`, so they outlive the
  // test that installed them; this config sets no `restoreMocks`.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const newPhaseRunner = (writer: AuditLogWriter): PhaseRunner =>
    new PhaseRunner(
      { invoke: vi.fn(), cancelActive: vi.fn(() => false), hasActiveProcess: false } as unknown as ClaudeCliRunner,
      new PromptBuilder(),
      writer,
      new SanitizedLogger()
    );

  it('sends an omitted phaseId to the whole-Run form and a named one to the pair form', () => {
    const perRun = vi.spyOn(PhaseRetryEvaluator.prototype, 'evictRunStagnationTrackers');
    const perPair = vi.spyOn(PhaseRetryEvaluator.prototype, 'evictStagnationTracker');
    const runner = newPhaseRunner(makeAuditWriter().writer);

    runner.evictStagnationTracker('run-1');
    expect(perRun).toHaveBeenCalledExactlyOnceWith('run-1');
    expect(perPair).not.toHaveBeenCalled();

    runner.evictStagnationTracker('run-1', 'speckit-specify');
    expect(perPair).toHaveBeenCalledExactlyOnceWith('run-1', 'speckit-specify');
    expect(perRun).toHaveBeenCalledTimes(1);
  });

  it('narrows to the pair even when the phaseId is the empty string', () => {
    // `if (phaseId === undefined)`, not `if (!phaseId)`. A phase id is
    // operator-authored (it comes from an imported process document), and a
    // falsy-check here would silently widen one malformed definition's pause
    // into a teardown of every OTHER phase of that Run — figures those phases
    // are still looping on. Identity comparison keeps the widening impossible.
    const perRun = vi.spyOn(PhaseRetryEvaluator.prototype, 'evictRunStagnationTrackers');
    const perPair = vi.spyOn(PhaseRetryEvaluator.prototype, 'evictStagnationTracker');

    newPhaseRunner(makeAuditWriter().writer).evictStagnationTracker('run-1', '');

    expect(perPair).toHaveBeenCalledExactlyOnceWith('run-1', '');
    expect(perRun).not.toHaveBeenCalled();
  });
});
