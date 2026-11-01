/**
 * FR-R4-F12 (FR-R4-004 / S-05; contract CP7, CP11; SC-001 per-basis controls; tests-and-gates T4) --
 * the real `PhaseRunner` does not advance a Phase on a completion token that has no complete audit
 * block before it, or that reached the host only as tool output.
 *
 * WHY IT EXISTS. The parser tests prove `parseInvocation` classifies each shape. They cannot show
 * that the production caller hands the parser what it needs: `textSource` is computed by the
 * unwrapper and must be forwarded by `phase-runner.ts`. Case 2 is that proof: a tool-use-only
 * stream-json holding a complete block and a token in tool output, which advances if the field is
 * not forwarded.
 *
 * The stub CLI is the one `phase-runner-host-verification.test.ts` and `warning-delivery.test.ts`
 * use. Nothing in the parse path is mocked. Fixtures are synthetic.
 */
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

const OPEN = '=== SCHEGENT AUDIT LOG ===';
const CLOSE = '=== END AUDIT LOG ===';
const TOKEN = '[SCHEGENT_STATUS: CLEAR]';

function block(): string[] {
  return [
    OPEN,
    'phase: speckit-specify',
    'files_created: []',
    'files_modified: []',
    'files_deleted: []',
    'commands_executed: []',
    'network_calls: ["none"]',
    'ruleset_switches: ["none"]',
    'notes: ok',
    CLOSE
  ];
}

const REGION_TOKEN_STDOUT = [...block(), TOKEN].join('\n');
const MID_PROSE_STDOUT = [
  'I reviewed the change.',
  `The completion line will read ${TOKEN} once everything is done.`,
  'Still working through the remaining items.'
].join('\n');
const MID_PROSE_TOKEN_REMOVED = MID_PROSE_STDOUT.split('\n')
  .filter((line) => !line.includes(TOKEN))
  .join('\n');

/** One stream-json assistant frame whose only content is a tool call: no model text. */
function toolUseFrame(command: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] }
  });
}
const TOOL_USE_ONLY_STDOUT = [OPEN, 'phase: speckit-specify', CLOSE, TOKEN].map(toolUseFrame).join('\n');

function buffer(text: string): ZippedStreamBuffer {
  const b = new ZippedStreamBuffer();
  if (text) b.append(text);
  b.finalize();
  return b;
}

const EXIT_CODE_BASIS: PhaseDef = {
  id: 'speckit-specify',
  name: 'Exit-code basis',
  hostVerification: 'exit-code'
} as PhaseDef;

const MODEL_TOKEN_BASIS: PhaseDef = {
  id: 'speckit-specify',
  name: 'Model-token basis',
  sideEffects: 'workspace',
  hostVerification: 'model-token'
} as PhaseDef;

const BASES: ReadonlyArray<{ name: string; phaseDef: PhaseDef }> = [
  { name: 'hostVerification exit-code', phaseDef: EXIT_CODE_BASIS },
  { name: 'hostVerification model-token', phaseDef: MODEL_TOKEN_BASIS }
];

async function runWith(
  stdout: string,
  phaseDef: PhaseDef,
  overrides: Partial<RawInvocationOutput> = {}
): Promise<Awaited<ReturnType<PhaseRunner['run']>>> {
  const runner = new PhaseRunner(
    {
      invoke: vi.fn(
        async (): Promise<RawInvocationOutput> =>
          ({
            stdoutBuffer: buffer(stdout),
            stderrBuffer: buffer(''),
            exitCode: 0,
            killed: false,
            timedOut: false,
            durationMs: 50,
            ...overrides
          }) as RawInvocationOutput
      ),
      cancelActive: vi.fn(() => false),
      hasActiveProcess: false
    } as unknown as ClaudeCliRunner,
    new PromptBuilder(),
    {
      append: vi.fn(
        async (entry: Omit<AuditEntry, 'id' | 'timestamp'>): Promise<AuditEntry> => ({
          id: 'audit-1',
          timestamp: '2026-11-01T00:00:00Z',
          ...entry
        })
      )
    } as unknown as AuditLogWriter,
    new SanitizedLogger()
  );
  return runner.run({
    phase: 'speckit-specify' as const,
    iteration: 1,
    iterationCap: 10,
    featureDescription: 'desc',
    featureDir: 'specs/001-mock',
    cliPath: 'claude',
    cwd: '/repo',
    timeoutMs: 5_000,
    runId: 'run-1',
    phaseDef
  });
}

describe('FR-R4-004 / S-05 -- a no-block echo does not advance, per verdict basis (CP7)', () => {
  it.each(BASES)('$name: a mid-prose token at exit 0 does not advance (case 1)', async ({ phaseDef }) => {
    const output = await runWith(MID_PROSE_STDOUT, phaseDef);

    expect(output.outcome).toBe('issues_remain');
    expect(output.result.kind).not.toBe('clean');
  });

  it.each(BASES)(
    '$name: a tool-use-only stream with a block and a token inside tool output does not advance (case 2)',
    async ({ phaseDef }) => {
      const output = await runWith(TOOL_USE_ONLY_STDOUT, phaseDef);

      expect(output.outcome).not.toBe('clean');
      expect(output.result.kind).not.toBe('clean');
    }
  );

  it.each(BASES)('$name: a block then a token still advances (case 3)', async ({ phaseDef }) => {
    const output = await runWith(REGION_TOKEN_STDOUT, phaseDef);

    expect(output.outcome).toBe('clean');
    expect(output.terminationReason).toBe('token');
  });
});

describe('FR-R4-004 / S-05 -- the timeout arm and the exit-code veto keep their outcome (case 4)', () => {
  // Today's outcome for a hung process that printed a region token, asserted by value. The
  // `exit-code` basis does not let the token override the timeout (FR-R3-058). The `model-token`
  // opt-out keeps BUG-002's reading: a hung-but-clean run is the model's own account of success.
  const TIMEOUT_WITH_REGION_TOKEN: Readonly<Record<string, string>> = {
    'hostVerification exit-code': 'timeout',
    'hostVerification model-token': 'clean'
  };

  it.each(BASES)('$name: a timeout keeps its outcome with or without a region token', async ({ name, phaseDef }) => {
    const withRegion = await runWith(REGION_TOKEN_STDOUT, phaseDef, { timedOut: true });
    const withoutRegion = await runWith(MID_PROSE_STDOUT, phaseDef, { timedOut: true });
    const tokenRemoved = await runWith(MID_PROSE_TOKEN_REMOVED, phaseDef, { timedOut: true });

    expect(withRegion.outcome).toBe(TIMEOUT_WITH_REGION_TOKEN[name]);
    expect(withoutRegion.outcome).toBe(tokenRemoved.outcome);
    expect(withoutRegion.terminationReason).toBe(tokenRemoved.terminationReason);
  });

  it('exit-code basis: a non-zero exit with a region token is the veto, as before', async () => {
    const output = await runWith(REGION_TOKEN_STDOUT, EXIT_CODE_BASIS, { exitCode: 3 });

    expect(output.outcome).toBe('failed');
    expect(output.result.kind).toBe('malformed');
  });

  it.each(BASES)(
    '$name: a non-zero exit with a no-region token reaches the token-removed outcome',
    async ({ phaseDef }) => {
      const withoutRegion = await runWith(MID_PROSE_STDOUT, phaseDef, { exitCode: 3 });
      const tokenRemoved = await runWith(MID_PROSE_TOKEN_REMOVED, phaseDef, { exitCode: 3 });

      expect(withoutRegion.outcome).toBe(tokenRemoved.outcome);
      expect(withoutRegion.terminationReason).toBe(tokenRemoved.terminationReason);
      expect(withoutRegion.result.kind).toBe(tokenRemoved.result.kind);
    }
  );
});

describe('FR-R4-004 / S-05 -- classification writes no state (CP11, case 5)', () => {
  function deepFreeze<T>(value: T): T {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.freeze(value);
      for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    }
    return value;
  }

  it.each(BASES)('$name: the PhaseDef passed in is deep-equal before and after, frozen', async ({ phaseDef }) => {
    const before = structuredClone(phaseDef);
    const frozen = deepFreeze(structuredClone(phaseDef));

    await runWith(MID_PROSE_STDOUT, frozen);
    await runWith(TOOL_USE_ONLY_STDOUT, frozen);
    await runWith(REGION_TOKEN_STDOUT, frozen);

    expect(frozen).toEqual(before);
  });
});
