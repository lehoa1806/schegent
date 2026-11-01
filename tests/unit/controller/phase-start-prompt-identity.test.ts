/**
 * FR-R4-F12 (FR-R4-102; contract PI4 to PI7; US2 scenarios 1 to 5; SC-004; tests-and-gates T6) -- the
 * `phase-start` audit row records a content-free prompt identity, and every reader of the log
 * tolerates a row with it and a row without it.
 *
 * WHY IT EXISTS. The identity is the one persisted addition of this feature. It must be written
 * through the real runner and the real append-only writer (hard rules 21 and 68), it must hold nothing
 * that recovers a prompt, a path or a secret (hard rules 1, 22 and 23), and it must not make any
 * existing reader warn on either shape of row (hard rule 5: unknown fields are preserved).
 *
 * WHAT IS REAL HERE: `PhaseRunner`, `PromptBuilder`, `AuditLogWriter` (with its generic projection and
 * its `sanitizeRecord` guard) under a temp root, `parseAuditLogLineDetailed`, `readMetrics` and
 * `projectAuditEntry`. The only stub is the CLI process.
 *
 * "OLD ROWS" are RECONSTRUCTED, and labelled as such: no captured pre-feature `phase-start` row of
 * this shape is committed, so each is a real row from the writer with the one field the earlier
 * writer did not emit removed, which is precisely the difference between the two writers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLogWriter } from '../../../src/audit/audit-log-writer';
import type { AuditEntry } from '../../../src/audit/audit-entry';
import { PhaseRunner, type PhaseRunInputs } from '../../../src/controller/phase-runner';
import { SanitizedLogger } from '../../../src/lib/logger';
import { clearMetricsCache, readMetrics } from '../../../src/metrics/metrics-service';
import { parseAuditLogLineDetailed } from '../../../src/parser/audit-log-parser';
import { PromptBuilder } from '../../../src/runner/prompt-builder';
import { PROMPT_COMPOSITION_VERSION, readPromptIdentity } from '../../../src/runner/prompt-identity';
import { ZippedStreamBuffer } from '../../../src/runner/zipped-stream-buffer';
import { projectAuditEntry } from '../../../src/ui/sidebar/audit-tail-projector';
import { REDACTION_CASES } from '../../fixtures/redaction-corpus';
import type { ClaudeCliRunner } from '../../../src/runner/claude-cli';
import type { PhaseDef } from '../../../src/config/pipeline-config';
import type { ExecutionEnvelope } from '../../../src/contracts/run-request';

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const FEATURE_DIR = 'specs/259-marker-feature-dir';
const SIDECAR_PATH = '.schegent/sessions/marker-session/phase-message.env';
const PATH_SHAPED = ['/Users/marker-user/work/marker-project', 'C:\\Users\\marker-user\\marker-project', '~/marker-home/notes.md'];

let workspaceRoot: string;

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'schegent-prompt-identity-'));
  clearMetricsCache();
  promptsSent.length = 0;
});

afterEach(async () => {
  clearMetricsCache();
  await rm(workspaceRoot, { recursive: true, force: true });
});

function buffer(text: string): ZippedStreamBuffer {
  const b = new ZippedStreamBuffer();
  b.append(text);
  b.finalize();
  return b;
}

/** Every prompt the stub CLI was handed, so a test can show its needles do reach the runner. */
const promptsSent: string[] = [];

function stubRunner(): ClaudeCliRunner {
  return {
    invoke: async (request: { prompt: string }) => {
      promptsSent.push(request.prompt);
      return {
        stdoutBuffer: buffer(''),
        stderrBuffer: buffer(''),
        exitCode: 0,
        killed: false,
        timedOut: false,
        durationMs: 1
      };
    },
    cancelActive: () => false,
    hasActiveProcess: false
  } as unknown as ClaudeCliRunner;
}

function envelopeWith(parts: { brief: string; instructions: string }): ExecutionEnvelope {
  return {
    pipeline: { id: 'e', name: 'E', phases: [{ id: 'c', name: 'C', version: 1, instruction: 'x' }] },
    inputs: [{ portId: 'brief', type: 'text', value: parts.brief }],
    supplemental: [{ kind: 'text', value: parts.brief }],
    outputs: [],
    instructions: parts.instructions,
    frozenAt: 1_700_000_000_000
  };
}

type RunExtras = Partial<PhaseRunInputs>;

/** Runs one real attempt under `root` and returns its `phase-start` row, read back from disk. */
async function runAndReadStartRow(root: string, extras: RunExtras = {}): Promise<Record<string, unknown>> {
  const logger = new SanitizedLogger();
  const writer = new AuditLogWriter({ workspaceRoot: root }, logger);
  const runner = new PhaseRunner(stubRunner(), new PromptBuilder(), writer, logger);
  await runner.run({
    phase: 'speckit-implement',
    pipelineId: 'standard',
    iteration: 1,
    iterationCap: 5,
    featureDescription: 'fixture',
    featureDir: null,
    cliPath: '/usr/bin/true',
    cwd: root,
    timeoutMs: 30_000,
    runId: 'run-identity-1',
    phaseDef: { id: 'speckit-implement', name: 'Implement', instruction: 'Do the work.' } as PhaseDef,
    ...extras
  });
  const rows = await readAuditRows(root);
  const start = rows.find((row) => row.eventType === 'phase-start');
  if (start === undefined) throw new Error('no phase-start row was written');
  return start;
}

async function readAuditRows(root: string): Promise<Array<Record<string, unknown>>> {
  const contents = await readFile(join(root, '.schegent', 'audit.log'), 'utf8');
  return contents
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function payloadOf(row: Record<string, unknown>): Record<string, unknown> {
  return row.payload as Record<string, unknown>;
}

async function writeLog(root: string, rows: ReadonlyArray<Record<string, unknown>>): Promise<void> {
  await mkdir(join(root, '.schegent'), { recursive: true });
  await writeFile(join(root, '.schegent', 'audit.log'), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
}

describe('FR-R4-102 -- recording (PI4)', () => {
  it('a composed attempt records a contract-scope identity with the pinned version and a digest', async () => {
    const row = await runAndReadStartRow(workspaceRoot);

    const identity = payloadOf(row).promptIdentity;
    expect(identity).toEqual({
      scope: 'contract',
      compositionVersion: PROMPT_COMPOSITION_VERSION,
      digest: expect.stringMatching(DIGEST_PATTERN)
    });
    expect(readPromptIdentity(payloadOf(row))).toEqual({ recorded: true, identity });
  });

  it('the recorded digest is the identity the builder composes for the same task block', async () => {
    const row = await runAndReadStartRow(workspaceRoot, {
      featureDescription: 'a different brief entirely',
      iteration: 3
    });
    const expected = new PromptBuilder().compose({
      phase: 'speckit-implement',
      phaseDef: { id: 'speckit-implement', name: 'Implement', instruction: 'Do the work.' } as PhaseDef,
      iteration: 1,
      iterationCap: 5,
      featureDescription: 'fixture',
      featureDir: null
    }).identity;

    expect(payloadOf(row).promptIdentity).toEqual(expected);
  });

  it('a stored-resume attempt records the resume scope and no digest key', async () => {
    const row = await runAndReadStartRow(workspaceRoot, { resumePrompt: 'RESUME-PROMPT-MARKER continue the work' });

    const identity = payloadOf(row).promptIdentity as Record<string, unknown>;
    expect(identity).toEqual({ scope: 'resume' });
    expect(Object.keys(identity)).toEqual(['scope']);
    expect(JSON.stringify(row)).not.toContain('RESUME-PROMPT-MARKER');
  });
});

describe('FR-R4-102 -- a row holds nothing that recovers content (PI7, SC-004)', () => {
  it('no row carries any instruction, brief, message, envelope value, path or prompt line', async () => {
    const secrets = REDACTION_CASES.filter((testCase) => testCase.expected === 'redacted' && testCase.secret !== undefined)
      .slice(0, 12)
      .map((testCase) => (testCase.secret as () => string)());
    const texts = REDACTION_CASES.slice(0, 12).map((testCase) => testCase.build());
    expect(secrets.length).toBeGreaterThanOrEqual(8);

    const leaky = [...secrets, ...PATH_SHAPED, 'INSTRUCTION-MARKER', 'BRIEF-MARKER', 'PHASE-MESSAGE-MARKER', 'ENVELOPE-MARKER'];
    const rows: Array<Record<string, unknown>> = [];
    for (const variant of ['composed', 'resume'] as const) {
      const root = await mkdtemp(join(tmpdir(), `schegent-prompt-identity-${variant}-`));
      try {
        rows.push(
          await runAndReadStartRow(root, {
            featureDescription: `BRIEF-MARKER ${PATH_SHAPED.join(' ')} ${texts.join(' ')}`,
            featureDir: FEATURE_DIR,
            phaseMessagePath: SIDECAR_PATH,
            previousPhaseMessage: { NOTE: `PHASE-MESSAGE-MARKER ${secrets.join(' ')}` },
            carriedIssues: [`ISSUE ${PATH_SHAPED.join(' ')}`],
            envelope: envelopeWith({ brief: `ENVELOPE-MARKER ${secrets.join(' ')}`, instructions: PATH_SHAPED.join(' ') }),
            phaseDef: {
              id: 'speckit-implement',
              name: 'Implement',
              instruction: `INSTRUCTION-MARKER ${secrets.join(' ')} ${PATH_SHAPED.join(' ')}`
            } as PhaseDef,
            ...(variant === 'resume' ? { resumePrompt: `RESUME ${secrets.join(' ')}` } : {}),
            cwd: root
          })
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }

    expect(rows).toHaveLength(2);
    // The control: the composed attempt's prompt DID carry every needle, so their absence from the row is a
    // finding about the row and not about an input that never reached the runner.
    const composedPrompt = promptsSent.at(0) ?? '';
    for (const needle of [...leaky, FEATURE_DIR, SIDECAR_PATH]) {
      expect(composedPrompt.includes(needle), `the prompt must carry the ${needle.length}-character needle`).toBe(true);
    }
    for (const row of rows) {
      const serialized = JSON.stringify(row);
      for (const needle of [...leaky, ...texts, FEATURE_DIR, SIDECAR_PATH]) {
        expect(serialized.includes(needle), `row leaks ${needle.length}-character value`).toBe(false);
      }
      // The identity itself: only literals, an integer and a hex digest.
      const identity = payloadOf(row).promptIdentity as Record<string, unknown>;
      const allowedKeys = new Set(['scope', 'compositionVersion', 'digest']);
      expect(Object.keys(identity).every((key) => allowedKeys.has(key))).toBe(true);
    }
  });

  it('the writer leaves the row unchanged under sanitizeRecord, and the cwd never appears', async () => {
    const row = await runAndReadStartRow(workspaceRoot);

    expect(JSON.stringify(new SanitizedLogger().sanitizeRecord(row))).toBe(JSON.stringify(row));
    expect(JSON.stringify(row).includes(workspaceRoot)).toBe(false);
  });
});

describe('FR-R4-102 -- old rows load with no new warning (PI6, FR-011)', () => {
  /** RECONSTRUCTED: a real row from the writer, minus the one field the pre-feature writer did not emit. */
  async function reconstructedOldRow(root: string): Promise<Record<string, unknown>> {
    const row = await runAndReadStartRow(root);
    const { promptIdentity: _removed, ...payload } = payloadOf(row);
    return { ...row, payload };
  }

  it('the line parser reads an old row without a warning, and the reader says not recorded', async () => {
    const old = await reconstructedOldRow(workspaceRoot);

    const parsed = parseAuditLogLineDetailed(JSON.stringify(old));

    expect(parsed.warning).toBeUndefined();
    expect(parsed.entry).not.toBeNull();
    expect(readPromptIdentity((parsed.entry as AuditEntry).payload)).toEqual({ recorded: false });
  });

  it('the metrics service ingests an old log with no parse warning', async () => {
    const root = await mkdtemp(join(tmpdir(), 'schegent-prompt-identity-old-'));
    try {
      const old = await reconstructedOldRow(workspaceRoot);
      await writeLog(root, [old]);

      const metrics = await readMetrics(root);

      expect(metrics.meta.parseWarnings).toBe(0);
      expect(metrics.meta.totalScannedEntries).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('the audit tail projects an old row', async () => {
    const old = await reconstructedOldRow(workspaceRoot);
    const parsed = parseAuditLogLineDetailed(JSON.stringify(old));

    const projected = projectAuditEntry(parsed.entry as AuditEntry);

    expect(projected.id).toBe(old.id);
    expect(projected.runId).toBe('run-identity-1');
  });
});

describe('FR-R4-102 -- rows that carry the field load with no new warning (FR-011, "MUST tolerate the field")', () => {
  const SHAPES: ReadonlyArray<{ name: string; extras: RunExtras; scope: 'contract' | 'resume' }> = [
    { name: 'contract', extras: {}, scope: 'contract' },
    { name: 'resume', extras: { resumePrompt: 'resume text' }, scope: 'resume' }
  ];

  it.each(SHAPES)('$name: a pair differing only by promptIdentity loads the same through every reader', async ({ extras, scope }) => {
    const withField = await runAndReadStartRow(workspaceRoot, extras);
    const { promptIdentity: _removed, ...payloadWithout } = payloadOf(withField);
    const withoutField = { ...withField, payload: payloadWithout };
    expect(payloadOf(withField).promptIdentity).toMatchObject({ scope });
    expect('promptIdentity' in payloadOf(withoutField)).toBe(false);

    // Line parser: both rows, no warning.
    const parsedWith = parseAuditLogLineDetailed(JSON.stringify(withField));
    const parsedWithout = parseAuditLogLineDetailed(JSON.stringify(withoutField));
    expect(parsedWith.warning).toBeUndefined();
    expect(parsedWithout.warning).toBeUndefined();

    // Metrics: two logs, one row each, identical id and timestamp; the results match.
    const rootWith = await mkdtemp(join(tmpdir(), 'schegent-prompt-identity-with-'));
    const rootWithout = await mkdtemp(join(tmpdir(), 'schegent-prompt-identity-without-'));
    try {
      await writeLog(rootWith, [withField]);
      await writeLog(rootWithout, [withoutField]);
      // A running task's duration is `now - start`, so the clock is held still across the two reads:
      // the only difference between the two logs is then the field under test.
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-11-01T12:00:00.000Z'));
      let metricsWith: Awaited<ReturnType<typeof readMetrics>>;
      let metricsWithout: Awaited<ReturnType<typeof readMetrics>>;
      try {
        metricsWith = await readMetrics(rootWith);
        metricsWithout = await readMetrics(rootWithout);
      } finally {
        vi.useRealTimers();
      }

      expect(metricsWith.meta.parseWarnings).toBe(0);
      expect(metricsWithout.meta.parseWarnings).toBe(0);
      expect(metricsWith).toEqual(metricsWithout);
    } finally {
      await rm(rootWith, { recursive: true, force: true });
      await rm(rootWithout, { recursive: true, force: true });
    }

    // Audit tail: the same projection for both rows.
    expect(projectAuditEntry(parsedWith.entry as AuditEntry)).toEqual(projectAuditEntry(parsedWithout.entry as AuditEntry));

    // The reader: recorded for one, not recorded for the other.
    expect(readPromptIdentity((parsedWith.entry as AuditEntry).payload).recorded).toBe(true);
    expect(readPromptIdentity((parsedWithout.entry as AuditEntry).payload)).toEqual({ recorded: false });
  });
});
