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
  it('advances a clean token over a non-zero exit when the phase is not marked', async () => {
    // The historical behaviour, pinned. Every existing definition depends on it,
    // and this feature must not change it.
    const { output } = await runWith({ exitCode: 3 }, ORDINARY);
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

  it('does not advance a marked phase that timed out, however clean the token', async () => {
    const { output } = await runWith({ timedOut: true }, SENSITIVE);
    expect(output.outcome).not.toBe('clean');
    expect(output.outcome).toBe('timeout');
  });

  it('still treats a hung-but-clean UNMARKED phase as success', async () => {
    // BUG-002 / FR-025, unchanged. This is the behaviour the marking opts out of,
    // not one it replaces.
    const { output } = await runWith({ timedOut: true }, ORDINARY);
    expect(output.outcome).not.toBe('timeout');
  });

  it('leaves a marked phase that exited zero alone', async () => {
    // The marking must not fail a phase that genuinely succeeded, or it would be
    // indistinguishable from disabling the phase.
    const { output } = await runWith({ exitCode: 0 }, SENSITIVE);
    expect(output.outcome).not.toBe('failed');
  });
});
