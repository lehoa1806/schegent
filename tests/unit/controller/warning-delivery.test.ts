/**
 * Feature 107 (FR-031, SC-011, SC-013) — delivery, not construction.
 *
 * The parser suite proves `parseInvocation` *returns* each warning. That is not
 * the property that matters: for three of these warnings the push existed all
 * along and the value was dropped one layer up. So this suite runs the real
 * `PhaseRunner` against real stdout, mocks nothing in the parse path, and
 * asserts each warning appears in the payload handed to the audit writer.
 *
 * It is also the check that FR-031 needed no phase-runner change: both consumers
 * there duck-type `'warnings' in result`, so widening the variant types was the
 * whole repair. If someone narrows either read, these tests fail.
 */
import { describe, it, expect, vi } from 'vitest';
import { PhaseRunner } from '../../../src/controller/phase-runner';
import { PromptBuilder } from '../../../src/runner/prompt-builder';
import { SanitizedLogger } from '../../../src/lib/logger';
import { ZippedStreamBuffer } from '../../../src/runner/zipped-stream-buffer';
import type { ClaudeCliRunner } from '../../../src/runner/claude-cli';
import type { AuditLogWriter } from '../../../src/audit/audit-log-writer';
import type { AuditEntry } from '../../../src/audit/audit-entry';
import type { RawInvocationOutput, InvocationRequest } from '../../../src/runner/invocation-result';

const OPEN = '=== SCHEGENT AUDIT LOG ===';
const CLOSE = '=== END AUDIT LOG ===';
const TOKEN = '[SCHEGENT_STATUS: CLEAR]';

function block(notes = 'work done'): string[] {
  return [
    OPEN,
    'phase: speckit-specify',
    'files_created: []',
    'files_modified: []',
    'files_deleted: []',
    'commands_executed: []',
    'network_calls: ["none"]',
    'ruleset_switches: ["none"]',
    `notes: ${notes}`,
    CLOSE
  ];
}

function buffer(text: string): ZippedStreamBuffer {
  const b = new ZippedStreamBuffer();
  if (text) b.append(text);
  b.finalize();
  return b;
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

/**
 * Run a phase against fixed stdout and return every warning that reached the
 * audit writer.
 */
async function deliveredWarnings(stdout: string, exitCode = 0): Promise<string[]> {
  const cliRunner = {
    invoke: vi.fn(
      async (_req: InvocationRequest): Promise<RawInvocationOutput> => ({
        stdoutBuffer: buffer(stdout),
        stderrBuffer: buffer(''),
        exitCode,
        killed: false,
        timedOut: false,
        durationMs: 50
      })
    ),
    cancelActive: vi.fn(() => false),
    hasActiveProcess: false
  } as unknown as ClaudeCliRunner;

  const appended: Array<Omit<AuditEntry, 'id' | 'timestamp'>> = [];
  let counter = 0;
  const auditWriter = {
    append: vi.fn(async (entry: Omit<AuditEntry, 'id' | 'timestamp'>): Promise<AuditEntry> => {
      appended.push(entry);
      return { id: `audit-${++counter}`, timestamp: '2026-08-21T00:00:00Z', ...entry };
    }),
    logPath: '/tmp/.schegent/audit.log'
  } as unknown as AuditLogWriter;

  const runner = new PhaseRunner(cliRunner, new PromptBuilder(), auditWriter, new SanitizedLogger());
  await runner.run(baseInputs);

  return appended.flatMap((entry) => {
    const warnings = (entry.payload as Record<string, unknown>).warnings;
    return Array.isArray(warnings) ? (warnings as string[]) : [];
  });
}

describe('constitution warnings reach the persisted audit entry (SC-011)', () => {
  it('delivers "missing audit log" from the no-contract-block path', async () => {
    const delivered = await deliveredWarnings('the model said nothing structured');

    expect(delivered).toContain('[constitution] missing audit log');
  });

  it('delivers "multiple contract blocks"', async () => {
    const stdout = [...block(), TOKEN, 'Remaining issues:', '- [build] one thing'].join('\n');

    expect(await deliveredWarnings(stdout)).toContain('[constitution] multiple contract blocks');
  });

  it('delivers "missing audit log on clean response"', async () => {
    expect(await deliveredWarnings(TOKEN)).toContain(
      '[constitution] missing audit log on clean response'
    );
  });

  it('delivers the degraded-path label', async () => {
    expect(await deliveredWarnings(TOKEN)).toContain(
      '[constitution] token accepted without audit block'
    );
  });

  it('delivers the multiple-audit-blocks warning', async () => {
    const stdout = [...block('first'), ...block('second'), TOKEN].join('\n');

    expect(await deliveredWarnings(stdout)).toContainEqual(
      expect.stringContaining('[constitution] multiple audit blocks')
    );
  });

  it('delivers the out-of-region token report', async () => {
    const stdout = [`claiming success: ${TOKEN}`, ...block()].join('\n');

    expect(await deliveredWarnings(stdout)).toContainEqual(
      expect.stringContaining('[constitution] termination token outside audit region')
    );
  });

  it('delivers the multiple-in-region-tokens warning', async () => {
    const stdout = [...block(), TOKEN, 'and again', TOKEN].join('\n');

    expect(await deliveredWarnings(stdout)).toContainEqual(
      expect.stringContaining('[constitution] multiple termination tokens in audit region')
    );
  });

  it('delivers the fenced-token warning', async () => {
    const stdout = [...block(), '```', TOKEN, '```'].join('\n');

    expect(await deliveredWarnings(stdout)).toContainEqual(
      expect.stringContaining('[constitution] termination token inside a code fence')
    );
  });

  it('delivers the out-of-region report even when the run failed', async () => {
    // `transient_error` is the variant most likely to be dropped, and the one
    // where an injected token is the most interesting thing in the record.
    const stdout = [`I am done: ${TOKEN}`, ...block()].join('\n');

    expect(await deliveredWarnings(stdout, 1)).toContainEqual(
      expect.stringContaining('[constitution] termination token outside audit region')
    );
  });
});

describe('the channel stays quiet on well-formed output (SC-013)', () => {
  it('delivers no warnings for a clean in-region token', async () => {
    expect(await deliveredWarnings([...block(), TOKEN].join('\n'))).toEqual([]);
  });
});
