import { describe, expect, it, vi } from 'vitest';
import { PhaseRunner } from '../../../src/controller/phase-runner';
import { PromptBuilder } from '../../../src/runner/prompt-builder';
import { SanitizedLogger } from '../../../src/lib/logger';
import { ZippedStreamBuffer } from '../../../src/runner/zipped-stream-buffer';
import type { ClaudeCliRunner } from '../../../src/runner/claude-cli';
import type { AuditLogWriter } from '../../../src/audit/audit-log-writer';
import type { AuditEntry } from '../../../src/audit/audit-entry';
import type { RawInvocationOutput } from '../../../src/runner/invocation-result';
import type { PhaseDef } from '../../../src/config/pipeline-config';

/**
 * FR-R3-058 (M-07 / R-10) — the agent whose work is judged also authored the
 * evidence that advanced it.
 *
 * Two arms did that. A timed-out process was treated as successful when its
 * output parsed clean, and a clean termination token overrode a non-zero exit
 * with only a `logger.warn`: "the model's successful completion takes
 * precedence". Both were recorded decisions -- FR-R3-023 verified evidence
 * *shape*, FR-R3-038 *disclosed* the self-certification -- and both deferred the
 * same step.
 *
 * The fixture below is exactly the acceptance criterion: a **perfect audit block
 * and a clean status token** alongside a host-verifiable check that failed.
 * Unmarked, it advances, as it always has. Marked
 * `hostVerification: 'exit-code'`, it does not.
 */
const CLEAN_STDOUT = [
  '=== SCHEGENT AUDIT LOG ===',
  'phase: speckit-specify',
  'files_created: []',
  'files_modified: []',
  'files_deleted: []',
  'commands_executed: []',
  'network_calls: ["none"]',
  'ruleset_switches: ["none"]',
  'notes: ok',
  '=== END AUDIT LOG ===',
  '[SCHEGENT_STATUS: CLEAR]'
].join('\n');

function buffer(text: string): ZippedStreamBuffer {
  const b = new ZippedStreamBuffer();
  b.append(text);
  b.finalize();
  return b;
}

function makeRawOutput(overrides: Partial<RawInvocationOutput> = {}): RawInvocationOutput {
  return {
    stdoutBuffer: buffer(CLEAN_STDOUT),
    stderrBuffer: buffer(''),
    exitCode: 0,
    killed: false,
    timedOut: false,
    durationMs: 50,
    ...overrides
  } as RawInvocationOutput;
}

const SENSITIVE: PhaseDef = {
  id: 'speckit-specify',
  name: 'Sensitive phase',
  hostVerification: 'exit-code'
} as PhaseDef;

const ORDINARY: PhaseDef = {
  id: 'speckit-specify',
  name: 'Ordinary phase'
} as PhaseDef;

/**
 * FR-R3-117 — a Phase that declares nothing is LOAD-BEARING, because `sideEffects`
 * resolves to `'workspace'`. `ORDINARY` is therefore exit-code-judged now.
 */

/** Declares `'none'`: purely advisory, so the historical self-report survives. */
const ADVISORY: PhaseDef = {
  id: 'speckit-specify',
  name: 'Advisory phase',
  sideEffects: 'none'
} as PhaseDef;

/** Load-bearing, and explicitly opts OUT — the FR-R3-117 escape hatch. */
const OPTED_OUT: PhaseDef = {
  id: 'speckit-specify',
  name: 'Opted-out phase',
  sideEffects: 'workspace',
  hostVerification: 'model-token'
} as PhaseDef;

async function runWith(
  overrides: Partial<RawInvocationOutput>,
  phaseDef?: PhaseDef
): Promise<{
  output: Awaited<ReturnType<PhaseRunner['run']>>;
  entries: Array<Omit<AuditEntry, 'id' | 'timestamp'>>;
}> {
  const entries: Array<Omit<AuditEntry, 'id' | 'timestamp'>> = [];
  const runner = new PhaseRunner(
    {
      invoke: vi.fn(async () => makeRawOutput(overrides)),
      cancelActive: vi.fn(() => false),
      hasActiveProcess: false
    } as unknown as ClaudeCliRunner,
    new PromptBuilder(),
    {
      append: vi.fn(async (entry: Omit<AuditEntry, 'id' | 'timestamp'>): Promise<AuditEntry> => {
        entries.push(entry);
        return { id: `audit-${entries.length}`, timestamp: '2026-08-24T00:00:00Z', ...entry };
      })
    } as unknown as AuditLogWriter,
    new SanitizedLogger()
  );
  const output = await runner.run({
    phase: 'speckit-specify' as const,
    iteration: 1,
    iterationCap: 10,
    featureDescription: 'desc',
    featureDir: 'specs/001-mock',
    cliPath: 'claude',
    cwd: '/repo',
    timeoutMs: 5_000,
    runId: 'run-1',
    ...(phaseDef ? { phaseDef } : {})
  });
  return { output, entries };
}

describe('a sensitive phase is not advanced by its own claim (FR-R3-058)', () => {
  it('FR-R3-117 — does NOT advance an unmarked phase over a non-zero exit', async () => {
    // THE INVERSION. Until FR-R3-117 this asserted the opposite, and the comment
    // above it read "the historical behaviour, pinned ... this feature must not
    // change it" -- true of FR-R3-058, which shipped the mechanism opt-in
    // deliberately to avoid breaking existing catalogs. FR-R3-117 is the migration
    // that opt-in deferred.
    //
    // An unmarked phase resolves `sideEffects` to 'workspace', so its claim is
    // load-bearing and it is judged on exit status. A failed build reporting
    // success was the single highest-consequence default in the product.
    const { output } = await runWith({ exitCode: 3 }, ORDINARY);
    expect(output.outcome).toBe('failed');
  });

  it("FR-R3-117 — advances a clean token over a non-zero exit when sideEffects is 'none'", async () => {
    // The carve-out. A purely advisory Phase touches nothing, so judging it on
    // exit status would break advisory Phases for no gain.
    const { output } = await runWith({ exitCode: 3 }, ADVISORY);
    expect(output.outcome).not.toBe('failed');
  });

  it('FR-R3-117 — an explicit model-token opt-out still advances', async () => {
    // The escape hatch RELEASE.md names. A load-bearing Phase whose author chose
    // self-report keeps it, and this is the only way to have it.
    const { output } = await runWith({ exitCode: 3 }, OPTED_OUT);
    expect(output.outcome).not.toBe('failed');
  });

  it('does not advance a marked phase whose exit code says it failed', async () => {
    // A perfect audit block and `[SCHEGENT_STATUS: CLEAR]`, and the process exited
    // 3. Before this, that was a `logger.warn` and a transition.
    const { output, entries } = await runWith({ exitCode: 3 }, SENSITIVE);
    expect(output.outcome).toBe('failed');
    expect(output.terminationReason).toBe('error');
    expect(output.result.kind).toBe('malformed');

    // The cause is recorded, not only the failure -- the 2026-08-16 lesson.
    const phaseEnd = entries.filter((e) => e.eventType === 'phase-end');
    expect(phaseEnd.length).toBeGreaterThan(0);
    const warnings = phaseEnd.at(-1)?.payload as { warnings?: readonly string[] } | undefined;
    expect(warnings?.warnings).toContain('host-verification-failed');
  });

  // FR-009 / SC-007 (BUG-001) — the exit status the gate reads must be one the
  // BACKEND produced.
  //
  // Both cases below are the same raw output as the `exitCode: 3` case above but
  // for one field, and they must reach the opposite verdict. The 143 is not the
  // backend's: the runner parsed the terminal `{"type":"result"}` line, waited out
  // FR-025's settle window, and SIGTERM'd a process that would not exit, so the
  // process tree reported `128 + 15`. Reading that as the host's verdict is the
  // runner reporting its own signal back to itself.
  //
  // Observed in the field on a `finalize` phase that had passed 9 of 9 checks, run
  // the host's own `npm run verify` twice at exit 0, committed 165 files and merged
  // them into `develop`. The durable record said the phase that performed the merge
  // failed, and the queue halted on it.
  //
  // THE NUMERIC CODE IS THE POINT. The only pre-existing fixture for this state
  // (`phase-runner-completion.test.ts`) pins `exitCode: null`, and `null` is the one
  // value the enforcing arm's `exitCode !== null && exitCode !== 0` guard cannot
  // see — so it passed with the defect present. Modelling only `null` + signal is
  // what made this invisible.
  it('SC-007 — advances a marked phase whose non-zero exit the RUNNER authored', async () => {
    const { output, entries } = await runWith(
      { completedAwaitingExit: true, timedOut: false, killed: false, exitCode: 143 },
      SENSITIVE
    );
    expect(output.outcome).toBe('clean');
    expect(output.terminationReason).toBe('token');
    expect(output.result.kind).toBe('clean');

    // Not merely "did not fail": the cause must not be recorded either. A phase
    // that advanced while its record says host verification failed is the same
    // defect one layer out.
    const recorded = entries
      .filter((e) => e.eventType === 'phase-end')
      .flatMap((e) => (e.payload as { warnings?: readonly string[] }).warnings ?? []);
    expect(recorded).not.toContain('host-verification-failed');
  });

  it('SC-007 — the same runner-authored exit advances an unmarked phase (control)', async () => {
    // The control. FR-R3-117 resolves an unmarked load-bearing phase to
    // `exit-code` as well, so this pair does not contrast enforcement with its
    // absence -- it contrasts a declared basis with a resolved one, and the two
    // must not disagree about a field that does not change completion semantics.
    const { output } = await runWith(
      { completedAwaitingExit: true, timedOut: false, killed: false, exitCode: 143 },
      ORDINARY
    );
    expect(output.outcome).toBe('clean');
  });

  it('does not advance a marked phase that timed out, however clean the token', async () => {
    const { output } = await runWith({ timedOut: true }, SENSITIVE);
    expect(output.outcome).not.toBe('clean');
    expect(output.outcome).toBe('timeout');
  });

  it('FR-R3-117 — a hung-but-clean UNMARKED phase is now a timeout', async () => {
    // Also inverted. An agent killed at the idle bound could be recorded as having
    // completed its phase, because the buffered output parsed clean. The timeout
    // decides now, not the token.
    const { output } = await runWith({ timedOut: true }, ORDINARY);
    expect(output.outcome).toBe('timeout');
  });

  it("still treats a hung-but-clean 'none' phase as success", async () => {
    // BUG-002 / FR-025, preserved exactly where it still applies.
    const { output } = await runWith({ timedOut: true }, ADVISORY);
    expect(output.outcome).not.toBe('timeout');
  });

  it('leaves a marked phase that exited zero alone', async () => {
    // The marking must not fail a phase that genuinely succeeded, or it would be
    // indistinguishable from disabling the phase.
    const { output } = await runWith({ exitCode: 0 }, SENSITIVE);
    expect(output.outcome).not.toBe('failed');
  });
});
