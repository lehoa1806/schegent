import { describe, expect, it, vi } from 'vitest';
import { RECORDABLE_PHASE_END_WARNINGS } from '../../../src/audit/audit-payload';
import { PhaseRunner } from '../../../src/controller/phase-runner';
import { PromptBuilder } from '../../../src/runner/prompt-builder';
import { SanitizedLogger } from '../../../src/lib/logger';
import { ZippedStreamBuffer } from '../../../src/runner/zipped-stream-buffer';
import type { ClaudeCliRunner } from '../../../src/runner/claude-cli';
import type { AuditLogWriter } from '../../../src/audit/audit-log-writer';
import type { AuditEntry } from '../../../src/audit/audit-entry';
import type { RawInvocationOutput } from '../../../src/runner/invocation-result';

/**
 * FR-R3-047 (H-04) — the delivery condition outranks a clean parse.
 *
 * The arm is pinned three ways: the diagnostic code is recordable (without it the
 * audit would say a run failed and not say why), the arm sits above every other
 * arm in the source order that decides precedence, and — the part source order
 * cannot show — the arm's BODY produces the documented verdict when it is
 * actually taken. Ordering alone would pass against an arm that returned the
 * wrong outcome, dropped the cause, or recorded no audit entry at all.
 */

/** A clean, terminal-token stdout: the evidence the arm must outrank. */
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
  };
}

function makeFakeRunner(raw: RawInvocationOutput): ClaudeCliRunner {
  return {
    invoke: vi.fn(async () => raw),
    cancelActive: vi.fn(() => false),
    hasActiveProcess: false
  } as unknown as ClaudeCliRunner;
}

function makeFakeAuditWriter(entries: Array<Omit<AuditEntry, 'id' | 'timestamp'>>): AuditLogWriter {
  let counter = 0;
  return {
    append: vi.fn(async (entry: Omit<AuditEntry, 'id' | 'timestamp'>): Promise<AuditEntry> => {
      entries.push(entry);
      return { id: `audit-${++counter}`, timestamp: '2026-08-23T00:00:00Z', ...entry };
    }),
    logPath: '/tmp/.schegent/audit.log'
  } as unknown as AuditLogWriter;
}

const baseInputs = {
  phase: 'speckit-specify' as const,
  iteration: 1,
  iterationCap: 10,
  featureDescription: 'desc',
  featureDir: 'specs/001-mock',
  cliPath: 'claude',
  cwd: '/repo',
  timeoutMs: 5_000,
  runId: 'run-1'
};

async function runWith(overrides: Partial<RawInvocationOutput>): Promise<{
  output: Awaited<ReturnType<PhaseRunner['run']>>;
  entries: Array<Omit<AuditEntry, 'id' | 'timestamp'>>;
}> {
  const entries: Array<Omit<AuditEntry, 'id' | 'timestamp'>> = [];
  const runner = new PhaseRunner(
    makeFakeRunner(makeRawOutput(overrides)),
    new PromptBuilder(),
    makeFakeAuditWriter(entries),
    new SanitizedLogger()
  );
  return { output: await runner.run(baseInputs), entries };
}
describe('stdin delivery precedence', () => {
  it('records the cause rather than only the failure', () => {
    // Not decoration: `outcome: 'failed'` / `terminationReason: 'error'` with no
    // stated cause is what made a real 2026-08-16 failure undiagnosable from the
    // audit alone. A code outside this set is counted and dropped, so if this
    // membership ever lapses the record silently loses the reason.
    expect(RECORDABLE_PHASE_END_WARNINGS.has('stdin-delivery-failed')).toBe(true);
  });

  it('is checked before every other arm of the decision chain', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const source = readFileSync(
      join(__dirname, '..', '..', '..', 'src', 'controller', 'phase-runner.ts'),
      'utf8'
    );
    const stdinArm = source.indexOf("if (raw.stdinDeliveryFailed && result.kind === 'clean')");
    const timeoutArm = source.indexOf("if (raw.timedOut && result.kind !== 'clean')");
    const killedArm = source.indexOf('if (raw.killed && raw.exitCode === null)');
    const cleanNonZero = source.indexOf("if (result.kind === 'clean' && raw.exitCode !== null");

    expect(stdinArm).toBeGreaterThan(-1);
    // A backend that heard half a prompt answered a different question, so its
    // termination token is not evidence about this phase.
    expect(stdinArm).toBeLessThan(timeoutArm);
    expect(stdinArm).toBeLessThan(killedArm);
    expect(stdinArm).toBeLessThan(cleanNonZero);
    // And the arms below it kept their relative order: this feature inserted
    // above an untouched chain rather than reordering it.
    expect(timeoutArm).toBeLessThan(killedArm);
    expect(killedArm).toBeLessThan(cleanNonZero);
  });
});

describe('stdin delivery classification (the arm, executed)', () => {
  it('fails the phase with a stated cause even though the parse is clean', async () => {
    const { output, entries } = await runWith({
      stdinDeliveryFailed: true,
      stdinErrorCode: 'EPIPE'
    });

    // The clean terminal token in stdout is deliberately present: a backend that
    // heard half a prompt answered a different question, so its own verdict is
    // not evidence about this phase.
    expect(output.outcome).toBe('failed');
    expect(output.terminationReason).toBe('error');
    expect(output.result.kind).toBe('malformed');
    // The errno reaches the operator; no byte of the prompt does.
    expect(output.warnings).toEqual(['prompt delivery to the backend failed (EPIPE)']);

    const phaseEnd = entries.filter((e) => e.eventType === 'phase-end');
    expect(phaseEnd).toHaveLength(1);
    expect(phaseEnd[0].outcome).toBe('failure');
    expect(phaseEnd[0].payload).toMatchObject({
      outcome: 'failed',
      terminationReason: 'error',
      warnings: ['stdin-delivery-failed']
    });
    expect(output.auditEntryId).toBeTruthy();
  });

  it('reports the exit code it observed rather than defaulting to a clean exit', async () => {
    // The projection defaults an absent `exitCode` to 0, so a killed child
    // (`null`) would otherwise be recorded as having exited cleanly.
    const { entries } = await runWith({
      stdinDeliveryFailed: true,
      stdinErrorCode: 'EPIPE',
      exitCode: null,
      killed: true
    });
    const phaseEnd = entries.find((e) => e.eventType === 'phase-end');
    expect(phaseEnd?.payload).toMatchObject({ exitCode: null });
  });

  it('keeps the parsed audit block evidence a clean parse already yielded', async () => {
    // The arm fires only on a CLEAN parse, so the audit block WAS read: the
    // backend may have changed the workspace while answering a truncated
    // prompt. Omitting this evidence recorded `fileChangeCounts: {0,0,0}` for a
    // run that created files, which is the record a reader needs most here.
    const withFiles = CLEAN_STDOUT
      .replace('files_created: []', 'files_created: ["src/a.ts"]')
      .replace('files_modified: []', 'files_modified: ["src/b.ts"]')
      .replace('commands_executed: []', 'commands_executed: ["npm test"]');
    const { entries } = await runWith({
      stdinDeliveryFailed: true,
      stdinErrorCode: 'EPIPE',
      stdoutBuffer: buffer(withFiles)
    });
    const phaseEnd = entries.find((e) => e.eventType === 'phase-end');
    expect(phaseEnd?.payload).toMatchObject({
      files_created: ['src/a.ts'],
      files_modified: ['src/b.ts'],
      commands_executed: ['npm test']
    });
  });

  it('keeps the warnings the invocation already carried', async () => {
    // The arm reclassifies the invocation; it does not get to forget what the
    // invocation reported. A clean parse with no audit log block is `clean` AND
    // carries `[constitution] missing audit log on clean response`, and the
    // runner appends its own `diagnosticWarnings` besides. Pinning the payload's
    // warning list to one element erased a constitution finding from the record
    // of the phase that earned it — the same evidence loss the `files_created`
    // block above exists to prevent.
    const { entries } = await runWith({
      stdinDeliveryFailed: true,
      stdinErrorCode: 'EPIPE',
      diagnosticWarnings: ['stdin-delivery-failed'],
      stdoutBuffer: buffer('[SCHEGENT_STATUS: CLEAR]')
    });
    const phaseEnd = entries.find((e) => e.eventType === 'phase-end');
    const warnings = (phaseEnd?.payload as { warnings?: string[] }).warnings ?? [];
    // The delivery code still leads: it is why this arm fired.
    expect(warnings[0]).toBe('stdin-delivery-failed');
    expect(warnings).toContain('[constitution] missing audit log on clean response');
  });

  it('does NOT override a timeout, because a timed-out run is not a clean claim', async () => {
    const { output } = await runWith({
      stdinDeliveryFailed: true,
      stdinErrorCode: 'EPIPE',
      timedOut: true,
      stdoutBuffer: buffer('')
    });
    // Narrowed during review, and this is the case that motivated it. The arm
    // exists to refuse a SUCCESS CLAIM made on a truncated prompt; a timed-out
    // run makes no such claim, and its parse is not clean. Firing here anyway
    // relabelled every fast-refusing backend — stale --resume id, bad flag, auth
    // or credit refusal — as a delivery defect, which swallowed `rate_limited`
    // and its reset-scheduled retry.
    expect(output.outcome).toBe('timeout');
    expect(output.terminationReason).toBe('timeout');
  });

  it('still records the delivery cause on a timeout', async () => {
    // The contract's other half: the arm narrowed to what it DECIDES, not to what
    // it RECORDS. Without the runner's `diagnosticWarnings` reaching the timeout
    // arm's payload, a truncated prompt on a timed-out run lived only in the
    // transient log.
    //
    // Deliberately not asserted: that arm's `exitCode`. It is omitted, so the
    // projection defaults it to 0 and records a clean exit for a SIGTERM-killed
    // child — a real pre-existing defect, filed rather than fixed here, because
    // it is not this item's arm to change.
    const { entries } = await runWith({
      stdinDeliveryFailed: true,
      stdinErrorCode: 'EPIPE',
      diagnosticWarnings: ['stdin-delivery-failed'],
      timedOut: true,
      exitCode: null,
      stdoutBuffer: buffer('')
    });
    const phaseEnd = entries.find((e) => e.eventType === 'phase-end');
    expect(phaseEnd?.payload).toMatchObject({
      outcome: 'timeout',
      warnings: ['stdin-delivery-failed']
    });
  });

  it('does not override a non-clean parse, leaving the backend its own cause', async () => {
    const { output } = await runWith({
      stdinDeliveryFailed: true,
      stdinErrorCode: 'EPIPE',
      exitCode: 1,
      stdoutBuffer: buffer('some diagnostic the backend printed before dying')
    });
    // The backend told us why it died; the EPIPE is downstream noise. `'error'`
    // here is the existing chain's own generic reason for a malformed parse, so
    // the property to assert is that THIS ARM did not fire — its warning is
    // absent, and the classification came from the normal path.
    expect(output.warnings).not.toContain('prompt delivery to the backend failed (EPIPE)');
  });

  it('names the condition even when the runner reported no errno', async () => {
    // No errno, but a clean parse — which is the only shape the arm now fires on.
    const { output } = await runWith({ stdinDeliveryFailed: true });
    expect(output.warnings).toEqual(['prompt delivery to the backend failed (unknown)']);
  });

  it('changes nothing when delivery succeeded', async () => {
    const { output } = await runWith({});
    expect(output.outcome).toBe('clean');
  });
});
