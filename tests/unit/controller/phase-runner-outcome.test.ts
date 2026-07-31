// Feature 013 — T043 (Wave 3 / US3 / FR-014).
//
// Defense-in-depth: even if a future parser regression returned `clean`
// alongside a non-zero exit code, the PhaseRunner MUST throw before
// persisting that outcome. T041 added the pre-persist assertion. This
// test pins the contract by mocking `parseInvocation` to return that
// impossible state and asserting the assertion fires.

import { describe, it, expect, vi } from 'vitest';
import { PromptBuilder } from '../../../src/runner/prompt-builder';
import { SanitizedLogger } from '../../../src/lib/logger';
import type { ClaudeCliRunner } from '../../../src/runner/claude-cli';
import type { AuditLogWriter } from '../../../src/audit/audit-log-writer';
import type { RawInvocationOutput, InvocationRequest } from '../../../src/runner/invocation-result';
import type { AuditEntry, AuditEntryFields } from '../../../src/audit/audit-entry';
import type { InvocationResult } from '../../../src/parser/stdout-parser';

// Override the parser to return the impossible state. `vi.mock` is
// hoisted above the static imports below, so we can `import { PhaseRunner }`
// at the top of the file and still receive the mocked parser at call time.
vi.mock('../../../src/parser/stdout-parser', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/parser/stdout-parser')>();
  return {
    ...original,
    parseInvocation: vi.fn(
      (): InvocationResult => ({
        kind: 'clean',
        auditEntry: {
          phase: 'speckit-specify',
          filesCreated: [],
          filesModified: [],
          filesDeleted: [],
          commandsExecuted: [],
          networkCalls: [],
          rulesetSwitches: [],
          notes: 'forced impossible',
          metrics: Object.freeze({}),
          warnings: Object.freeze([] as string[])
        } as AuditEntryFields
      })
    )
  };
});

import { PhaseRunner } from '../../../src/controller/phase-runner';

function makeRawOutput(overrides: Partial<RawInvocationOutput> = {}): RawInvocationOutput {
  return {
    stdout: '[SCHEGENT_STATUS: CLEAR]',
    stderr: '',
    exitCode: 0,
    killed: false,
    timedOut: false,
    durationMs: 50,
    ...overrides
  };
}

function makeFakeRunner(invokeImpl: (req: InvocationRequest) => Promise<RawInvocationOutput>): ClaudeCliRunner {
  return {
    invoke: vi.fn(invokeImpl),
    cancelActive: vi.fn(() => false),
    hasActiveProcess: false
  } as unknown as ClaudeCliRunner;
}

function makeFakeAuditWriter(): AuditLogWriter {
  let counter = 0;
  return {
    append: vi.fn(async (entry: Omit<AuditEntry, 'id' | 'timestamp'>): Promise<AuditEntry> => ({
      id: `audit-${++counter}`,
      timestamp: '2026-05-11T00:00:00Z',
      ...entry
    })),
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

describe('PhaseRunner.run — clean-with-non-zero-exit handling (T043 / FR-014)', () => {
  it('succeeds with clean outcome when parser returns clean with non-zero exit', async () => {
    const cliRunner = makeFakeRunner(async () =>
      makeRawOutput({ exitCode: 1 })
    );
    const logger = new SanitizedLogger();
    const warnSpy = vi.spyOn(logger, 'warn');
    const runner = new PhaseRunner(
      cliRunner,
      new PromptBuilder(),
      makeFakeAuditWriter(),
      logger
    );
    const output = await runner.run(baseInputs);
    expect(output.outcome).toBe('clean');
    expect(warnSpy).toHaveBeenCalledWith(
      'phase-runner: clean result with non-zero exit code',
      expect.objectContaining({ exitCode: 1 })
    );
  });

  it('logs warning with exit code details for observability', async () => {
    const cliRunner = makeFakeRunner(async () =>
      makeRawOutput({ exitCode: 137 })
    );
    const logger = new SanitizedLogger();
    const warnSpy = vi.spyOn(logger, 'warn');
    const runner = new PhaseRunner(
      cliRunner,
      new PromptBuilder(),
      makeFakeAuditWriter(),
      logger
    );
    const output = await runner.run(baseInputs);
    expect(output.outcome).toBe('clean');
    expect(warnSpy).toHaveBeenCalledWith(
      'phase-runner: clean result with non-zero exit code',
      expect.objectContaining({ exitCode: 137 })
    );
  });
});
