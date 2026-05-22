import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PhaseRetryEvaluator } from '../../../src/controller/phase-retry-evaluator';
import type { PhaseRetryEvaluatorInputs } from '../../../src/controller/phase-retry-evaluator';
import { SanitizedLogger } from '../../../src/lib/logger';
import type { AuditLogWriter } from '../../../src/audit/audit-log-writer';
import type { AuditEntry } from '../../../src/audit/audit-entry';
import type { InvocationResult } from '../../../src/parser/stdout-parser';
import type { PhaseDef } from '../../../src/config/pipeline-config';

function makeAuditWriter(): {
  writer: AuditLogWriter;
  appends: Array<{ eventType: string; payload: Record<string, unknown>; outcome: string }>;
} {
  const appends: Array<{ eventType: string; payload: Record<string, unknown>; outcome: string }> = [];
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
