import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PhaseRunner } from '../../../src/controller/phase-runner';
import { PromptBuilder } from '../../../src/runner/prompt-builder';
import { SanitizedLogger } from '../../../src/lib/logger';
import type { ClaudeCliRunner } from '../../../src/runner/claude-cli';
import type { AuditLogWriter } from '../../../src/audit/audit-log-writer';
import type {
  RawInvocationOutput,
  InvocationRequest
} from '../../../src/runner/invocation-result';
import type { AuditEntry } from '../../../src/audit/audit-entry';

/**
 * Feature 042 — verify that `RawInvocationOutput.stdoutTruncated` and
 * `stderrTruncated` are forwarded onto the `phase-end` audit payload
 * when `true`, and omitted when `false`/`undefined`.
 */

const cleanStdout = [
  '[SCHEGENT_STATUS: CLEAR]',
  '=== SCHEGENT AUDIT LOG ===',
  'phase: speckit-specify',
  'files_created: ["specs/001-mock/spec.md"]',
  'files_modified: []',
  'files_deleted: []',
  'commands_executed: ["mock specify"]',
  'network_calls: ["none"]',
  'ruleset_switches: ["none"]',
  'notes: ok',
  '=== END AUDIT LOG ==='
].join('\n');

function makeRawOutput(overrides: Partial<RawInvocationOutput> = {}): RawInvocationOutput {
  return {
    stdout: cleanStdout,
    stderr: '',
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
        timestamp: '2026-05-16T00:00:00Z',
        ...entry
      })
    ),
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

describe('PhaseRunner — truncation forwarding to phase-end (Feature 042)', () => {
  let auditWriter: AuditLogWriter;

  beforeEach(() => {
    auditWriter = makeFakeAuditWriter();
  });

  it('forwards stdoutTruncated=true onto the phase-end payload', async () => {
    const cli = makeFakeRunner(async () =>
      makeRawOutput({ stdoutTruncated: true })
    );
    const runner = new PhaseRunner(cli, new PromptBuilder(), auditWriter, new SanitizedLogger());
    await runner.run(baseInputs);

    const appendFn = auditWriter.append as ReturnType<typeof vi.fn>;
    const end = appendFn.mock.calls.find((c) => c[0].eventType === 'phase-end');
    expect(end?.[0].payload).toMatchObject({ stdoutTruncated: true });
    expect(end?.[0].payload).not.toHaveProperty('stderrTruncated');
  });

  it('forwards stderrTruncated=true onto the phase-end payload', async () => {
    const cli = makeFakeRunner(async () =>
      makeRawOutput({ stderrTruncated: true })
    );
    const runner = new PhaseRunner(cli, new PromptBuilder(), auditWriter, new SanitizedLogger());
    await runner.run(baseInputs);

    const appendFn = auditWriter.append as ReturnType<typeof vi.fn>;
    const end = appendFn.mock.calls.find((c) => c[0].eventType === 'phase-end');
    expect(end?.[0].payload).toMatchObject({ stderrTruncated: true });
    expect(end?.[0].payload).not.toHaveProperty('stdoutTruncated');
  });

  it('forwards BOTH flags when both are true', async () => {
    const cli = makeFakeRunner(async () =>
      makeRawOutput({ stdoutTruncated: true, stderrTruncated: true })
    );
    const runner = new PhaseRunner(cli, new PromptBuilder(), auditWriter, new SanitizedLogger());
    await runner.run(baseInputs);

    const appendFn = auditWriter.append as ReturnType<typeof vi.fn>;
    const end = appendFn.mock.calls.find((c) => c[0].eventType === 'phase-end');
    expect(end?.[0].payload).toMatchObject({
      stdoutTruncated: true,
      stderrTruncated: true
    });
  });

  it('omits truncation fields when neither flag is set (default raw output)', async () => {
    const cli = makeFakeRunner(async () => makeRawOutput());
    const runner = new PhaseRunner(cli, new PromptBuilder(), auditWriter, new SanitizedLogger());
    await runner.run(baseInputs);

    const appendFn = auditWriter.append as ReturnType<typeof vi.fn>;
    const end = appendFn.mock.calls.find((c) => c[0].eventType === 'phase-end');
    expect(end?.[0].payload).not.toHaveProperty('stdoutTruncated');
    expect(end?.[0].payload).not.toHaveProperty('stderrTruncated');
  });

  it('omits truncation fields when the flag is explicitly false', async () => {
    const cli = makeFakeRunner(async () =>
      makeRawOutput({ stdoutTruncated: false, stderrTruncated: false })
    );
    const runner = new PhaseRunner(cli, new PromptBuilder(), auditWriter, new SanitizedLogger());
    await runner.run(baseInputs);

    const appendFn = auditWriter.append as ReturnType<typeof vi.fn>;
    const end = appendFn.mock.calls.find((c) => c[0].eventType === 'phase-end');
    expect(end?.[0].payload).not.toHaveProperty('stdoutTruncated');
    expect(end?.[0].payload).not.toHaveProperty('stderrTruncated');
  });

  it('forwards truncation onto the timeout-path phase-end payload', async () => {
    const cli = makeFakeRunner(async () =>
      makeRawOutput({
        stdout: '',
        stderr: '',
        exitCode: null,
        timedOut: true,
        stdoutTruncated: true
      })
    );
    const runner = new PhaseRunner(cli, new PromptBuilder(), auditWriter, new SanitizedLogger());
    await runner.run(baseInputs);

    const appendFn = auditWriter.append as ReturnType<typeof vi.fn>;
    const end = appendFn.mock.calls.find(
      (c) => c[0].eventType === 'phase-end' && c[0].payload?.reason === 'timeout'
    );
    expect(end).toBeDefined();
    expect(end?.[0].payload).toMatchObject({ stdoutTruncated: true, reason: 'timeout' });
  });
});
