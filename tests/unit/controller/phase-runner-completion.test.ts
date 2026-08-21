import { ZippedStreamBuffer } from '../../../src/runner/zipped-stream-buffer';
// Feature 030 BUG-002 — PhaseRunner completion-vs-timeout classification.
//
// A CLI that emits its terminal result (a `[SCHEGENT_STATUS: DONE]` token plus
// a complete SCHEGENT AUDIT LOG block) but does not exit is either killed by the
// runner's idle timeout (`timedOut: true`) or grace-terminated after the
// completion marker (`completedAwaitingExit: true`). In BOTH cases the captured
// stdout holds a complete clean result, so PhaseRunner MUST classify the outcome
// as `clean` (FR-025) — not discard it as a `timeout` failure, which halts the
// run and blocks FR-002 promotion of the next task. A genuine no-output idle
// stall MUST still classify as `timeout`.

import { describe, it, expect, vi } from 'vitest';
import { PromptBuilder } from '../../../src/runner/prompt-builder';
import { SanitizedLogger } from '../../../src/lib/logger';
import type { ClaudeCliRunner } from '../../../src/runner/claude-cli';
import type { AuditLogWriter } from '../../../src/audit/audit-log-writer';
import type {
  RawInvocationOutput,
  InvocationRequest
} from '../../../src/runner/invocation-result';
import type { AuditEntry } from '../../../src/audit/audit-entry';
import { PhaseRunner } from '../../../src/controller/phase-runner';

// A complete, successful phase transcript: the clean-status token plus a
// well-formed SCHEGENT AUDIT LOG block carrying every required field.
// Feature 107 (T623) — the token trails the audit block, as the constitution's
// Output Formatting contract has always required ("the **last non-empty line**
// of stdout for terminal phases"). This fixture put it first, a shape no
// compliant run emits; the host only began enforcing the rule when the trailing
// region landed.
const CLEAN_STDOUT = [
  '=== SCHEGENT AUDIT LOG ===',
  'phase: speckit-implement',
  'files_created: []',
  'files_modified: []',
  'files_deleted: []',
  'commands_executed: []',
  'network_calls: []',
  'ruleset_switches: []',
  'notes: completed before the process exited',
  '=== END AUDIT LOG ===',
  '[SCHEGENT_STATUS: DONE]'
].join('\n');


type MockRawOutput = Omit<Partial<RawInvocationOutput>, 'stdoutBuffer' | 'stderrBuffer'> & { stdout?: string; stderr?: string };

function makeRawOutput(overrides: MockRawOutput = {}): RawInvocationOutput {
  const stdoutStr = overrides.stdout ?? CLEAN_STDOUT;
  const stderrStr = overrides.stderr ?? '';
  const stdoutBuffer = new ZippedStreamBuffer();
  stdoutBuffer.append(stdoutStr);
  stdoutBuffer.finalize();
  const stderrBuffer = new ZippedStreamBuffer();
  stderrBuffer.append(stderrStr);
  stderrBuffer.finalize();

  return {
    stdoutBuffer,
    stderrBuffer,

    exitCode: overrides.exitCode !== undefined ? overrides.exitCode : 0,
    killed: overrides.killed ?? false,
    timedOut: overrides.timedOut ?? false,
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
        timestamp: '2026-06-07T00:00:00Z',
        ...entry
      })
    ),
    logPath: '/tmp/.schegent/audit.log'
  } as unknown as AuditLogWriter;
}

const baseInputs = {
  phase: 'speckit-implement' as const,
  iteration: 1,
  iterationCap: 10,
  featureDescription: 'desc',
  featureDir: 'specs/030-single-task-queue',
  cliPath: 'claude',
  cwd: '/repo',
  timeoutMs: 5_000,
  runId: 'run-1'
};

function newRunner(cliRunner: ClaudeCliRunner): PhaseRunner {
  return new PhaseRunner(
    cliRunner,
    new PromptBuilder(),
    makeFakeAuditWriter(),
    new SanitizedLogger()
  );
}

describe('PhaseRunner.run — BUG-002 completed-but-non-exiting classification', () => {
  it('classifies a timed-out invocation whose stdout holds a complete clean result as clean (FR-025)', async () => {
    const cliRunner = makeFakeRunner(async () =>
      makeRawOutput({ timedOut: true, exitCode: null, stdout: CLEAN_STDOUT })
    );
    const out = await newRunner(cliRunner).run(baseInputs);
    expect(out.outcome).toBe('clean');
    expect(out.result.kind).toBe('clean');
  });

  it('classifies a completedAwaitingExit invocation (marker seen, process lingered) as clean', async () => {
    const cliRunner = makeFakeRunner(async () =>
      makeRawOutput({
        completedAwaitingExit: true,
        timedOut: false,
        killed: false,
        exitCode: null,

      })
    );
    const out = await newRunner(cliRunner).run(baseInputs);
    expect(out.outcome).toBe('clean');
  });

  it('still classifies a genuine no-output idle stall as timeout', async () => {
    const cliRunner = makeFakeRunner(async () =>
      makeRawOutput({ timedOut: true, exitCode: null, stdout: '' })
    );
    const out = await newRunner(cliRunner).run(baseInputs);
    expect(out.outcome).toBe('timeout');
  });
});
