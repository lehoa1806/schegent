import { ZippedStreamBuffer } from '../../../src/runner/zipped-stream-buffer';
// Feature 028 — PhaseRunner breakpoint dispatch tests.
//
// Verifies the runner-side half of US2 (future-phase breakpoints):
//   - When `PhaseBreakpointAccessor.readBreakpointPhaseIds(runId)` returns a
//     set containing the about-to-run phase id, the runner short-circuits
//     BEFORE invoking the CLI, emits `phase-breakpoint-fired`, and returns
//     `outcome: 'paused-at-breakpoint'` with `warnings: ['breakpoint-paused']`.
//   - When the set does NOT contain the id, the runner proceeds normally.
//   - The accessor is read at the dispatch boundary on every `run()` call —
//     never cached on the runner — so toggling the accessor's return between
//     back-to-back invocations changes the outcome accordingly.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PhaseRunner } from '../../../src/controller/phase-runner';
import { PromptBuilder } from '../../../src/runner/prompt-builder';
import { SanitizedLogger } from '../../../src/lib/logger';
import type { ClaudeCliRunner } from '../../../src/runner/claude-cli';
import type { AuditLogWriter } from '../../../src/audit/audit-log-writer';
import type { RawInvocationOutput, InvocationRequest } from '../../../src/runner/invocation-result';
import type { AuditEntry } from '../../../src/audit/audit-entry';
import type { PhaseBreakpointAccessor } from '../../../src/controller/breakpoint-accessor';

// Feature 107 (T623) — the token trails the audit block, as the constitution's
// Output Formatting contract has always required ("the **last non-empty line**
// of stdout for terminal phases"). This fixture put it first, a shape no
// compliant run emits; the host only began enforcing the rule when the trailing
// region landed.
const cleanStdout = [
  '=== SCHEGENT AUDIT LOG ===',
  'phase: speckit-clarify',
  'files_created: []',
  'files_modified: []',
  'files_deleted: []',
  'commands_executed: ["mock"]',
  'network_calls: ["none"]',
  'ruleset_switches: ["none"]',
  'notes: ok',
  '=== END AUDIT LOG ===',
  '[SCHEGENT_STATUS: CLEAR]'
].join('\n');

type MockRawOutput = Omit<Partial<RawInvocationOutput>, 'stdoutBuffer' | 'stderrBuffer'> & { stdout?: string; stderr?: string };

function makeRawOutput(overrides: MockRawOutput = {}): RawInvocationOutput {
  return {
    stdoutBuffer: (() => { const b = new ZippedStreamBuffer(); b.append(overrides.stdout ?? cleanStdout); b.finalize(); return b; })(),
    stderrBuffer: (() => { const b = new ZippedStreamBuffer(); b.append(overrides.stderr ?? ''); b.finalize(); return b; })(),
    exitCode: 0,
    killed: false,
    timedOut: false,
    durationMs: 50,
    ...overrides
  };
}

function makeFakeRunner(
  invokeImpl: (req: InvocationRequest) => Promise<RawInvocationOutput>
): ClaudeCliRunner {
  return {
    invoke: vi.fn(invokeImpl),
    cancelActive: vi.fn(() => false),
    hasActiveProcess: false
  } as unknown as ClaudeCliRunner;
}

function makeFakeAuditWriter(): AuditLogWriter {
  let counter = 0;
  return {
    append: vi.fn(
      async (entry: Omit<AuditEntry, 'id' | 'timestamp'>): Promise<AuditEntry> => ({
        id: `audit-${++counter}`,
        timestamp: '2026-05-15T00:00:00Z',
        ...entry
      })
    ),
    logPath: '/tmp/.schegent/audit.log'
  } as unknown as AuditLogWriter;
}

function makeBreakpointAccessor(
  readImpl: (runId: string) => ReadonlySet<string>
): PhaseBreakpointAccessor {
  return {
    readBreakpointPhaseIds: vi.fn(readImpl)
  } as unknown as PhaseBreakpointAccessor;
}

const baseInputs = {
  phase: 'speckit-clarify' as const,
  iteration: 1,
  iterationCap: 10,
  featureDescription: 'desc',
  featureDir: 'specs/001-mock',
  cliPath: 'claude',
  cwd: '/repo',
  timeoutMs: 5_000,
  runId: 'run-bp-1',
  pipelineId: 'standard'
};

describe('PhaseRunner — phase-breakpoint dispatch (Feature 028, US2)', () => {
  let cliRunner: ClaudeCliRunner;
  let auditWriter: AuditLogWriter;

  beforeEach(() => {
    auditWriter = makeFakeAuditWriter();
  });

  it('short-circuits BEFORE CLI invoke when breakpoint set contains the phase id', async () => {
    cliRunner = makeFakeRunner(async () => makeRawOutput());
    const accessor = makeBreakpointAccessor(() => new Set(['speckit-clarify']));
    const runner = new PhaseRunner(
      cliRunner,
      new PromptBuilder(),
      auditWriter,
      new SanitizedLogger(),
      null,
      null,
      null,
      null,
      null,
      accessor
    );

    const out = await runner.run(baseInputs);

    expect(cliRunner.invoke).not.toHaveBeenCalled();
    expect(out.outcome).toBe('paused-at-breakpoint');
    expect(out.warnings).toEqual(['breakpoint-paused']);
    expect(out.terminationReason).toBe('cancel');
    expect(out.exitCode).toBeNull();
    expect(out.result.kind).toBe('malformed');
    expect(out.auditEntryId).toBe('audit-1');
    expect(auditWriter.append).toHaveBeenCalledTimes(1);
    expect(auditWriter.append).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'phase-breakpoint-fired',
        runId: 'run-bp-1',
        phase: 'speckit-clarify',
        iteration: 1,
        outcome: 'info',
        payload: expect.objectContaining({
          pipelineId: 'standard',
          phaseId: 'speckit-clarify',
          iterationN: 1
        })
      })
    );
  });

  it('proceeds normally when the breakpoint set does NOT contain the phase id', async () => {
    cliRunner = makeFakeRunner(async () => makeRawOutput());
    const accessor = makeBreakpointAccessor(() => new Set(['speckit-implement']));
    const runner = new PhaseRunner(
      cliRunner,
      new PromptBuilder(),
      auditWriter,
      new SanitizedLogger(),
      null,
      null,
      null,
      null,
      null,
      accessor
    );

    const out = await runner.run(baseInputs);

    expect(cliRunner.invoke).toHaveBeenCalledTimes(1);
    expect(out.outcome).toBe('clean');
    expect(out.terminationReason).toBe('token');
    expect(auditWriter.append).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'phase-breakpoint-fired' })
    );
  });

  it('proceeds normally when no accessor is supplied (back-compat)', async () => {
    cliRunner = makeFakeRunner(async () => makeRawOutput());
    const runner = new PhaseRunner(
      cliRunner,
      new PromptBuilder(),
      auditWriter,
      new SanitizedLogger()
    );

    const out = await runner.run(baseInputs);

    expect(cliRunner.invoke).toHaveBeenCalledTimes(1);
    expect(out.outcome).toBe('clean');
  });

  it('proceeds normally when accessor returns an empty set', async () => {
    cliRunner = makeFakeRunner(async () => makeRawOutput());
    const accessor = makeBreakpointAccessor(() => new Set<string>());
    const runner = new PhaseRunner(
      cliRunner,
      new PromptBuilder(),
      auditWriter,
      new SanitizedLogger(),
      null,
      null,
      null,
      null,
      null,
      accessor
    );

    const out = await runner.run(baseInputs);

    expect(cliRunner.invoke).toHaveBeenCalledTimes(1);
    expect(out.outcome).toBe('clean');
  });

  it('reads the accessor on every run() — toggling between calls flips the outcome', async () => {
    cliRunner = makeFakeRunner(async () => makeRawOutput());
    // Live state — the accessor reads it on every call. Mirrors the no-cache
    // invariant in `breakpoint-accessor.ts`: toggling the source after the
    // first run() must alter the second run()'s outcome with no runner re-init.
    let breakpoints = new Set<string>(['speckit-clarify']);
    const accessor = makeBreakpointAccessor(() => breakpoints);
    const runner = new PhaseRunner(
      cliRunner,
      new PromptBuilder(),
      auditWriter,
      new SanitizedLogger(),
      null,
      null,
      null,
      null,
      null,
      accessor
    );

    // First call: breakpoint is armed → paused-at-breakpoint, no CLI spawn.
    const first = await runner.run(baseInputs);
    expect(first.outcome).toBe('paused-at-breakpoint');
    expect(cliRunner.invoke).toHaveBeenCalledTimes(0);

    // Operator clears the breakpoint between iterations.
    breakpoints = new Set<string>();

    // Second call: accessor re-read → empty set → CLI spawn proceeds, clean.
    const second = await runner.run({ ...baseInputs, iteration: 2 });
    expect(second.outcome).toBe('clean');
    expect(cliRunner.invoke).toHaveBeenCalledTimes(1);
  });

  it('passes the correct runId to the accessor (per-run scoping)', async () => {
    cliRunner = makeFakeRunner(async () => makeRawOutput());
    const readMock = vi.fn((runId: string): ReadonlySet<string> => {
      // Only halt for the run we care about; any other runId proceeds.
      return runId === 'run-bp-1' ? new Set(['speckit-clarify']) : new Set();
    });
    const accessor: PhaseBreakpointAccessor = { readBreakpointPhaseIds: readMock };
    const runner = new PhaseRunner(
      cliRunner,
      new PromptBuilder(),
      auditWriter,
      new SanitizedLogger(),
      null,
      null,
      null,
      null,
      null,
      accessor
    );

    const haltOut = await runner.run({ ...baseInputs, runId: 'run-bp-1' });
    expect(haltOut.outcome).toBe('paused-at-breakpoint');
    expect(readMock).toHaveBeenLastCalledWith('run-bp-1');

    const cleanOut = await runner.run({ ...baseInputs, runId: 'run-other' });
    expect(cleanOut.outcome).toBe('clean');
    expect(readMock).toHaveBeenLastCalledWith('run-other');
  });

  it('uses phaseDef.id over the legacy phase enum when both are set', async () => {
    cliRunner = makeFakeRunner(async () => makeRawOutput());
    const accessor = makeBreakpointAccessor(() => new Set(['custom-review']));
    const runner = new PhaseRunner(
      cliRunner,
      new PromptBuilder(),
      auditWriter,
      new SanitizedLogger(),
      null,
      null,
      null,
      null,
      null,
      accessor
    );

    const out = await runner.run({
      ...baseInputs,
      phase: 'speckit-clarify',
      phaseDef: {
        id: 'custom-review',
        name: 'Custom Review',
        instruction: 'noop',
        
      }
    });

    expect(cliRunner.invoke).not.toHaveBeenCalled();
    expect(out.outcome).toBe('paused-at-breakpoint');
    expect(auditWriter.append).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'phase-breakpoint-fired',
        payload: expect.objectContaining({ phaseId: 'custom-review' })
      })
    );
  });
});
