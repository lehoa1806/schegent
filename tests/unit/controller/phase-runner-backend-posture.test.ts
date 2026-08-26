// FR-R3-064 — the per-run backend-posture record.
//
// The shipped `schegent.backend.allowUncontainedBackends` description promised
// that "every run that uses an uncontained backend records the fact in the audit
// log" and nothing recorded it. These tests are what make the sentence true
// rather than intended, so each one pins a property the sentence depends on:
// the record exists, it is per Run rather than per phase, it carries the posture
// as it read at that moment rather than at activation, a contained backend is
// not misrecorded as consent, and a Run cannot proceed unrecorded.
import { describe, it, expect, vi } from 'vitest';
import { PromptBuilder } from '../../../src/runner/prompt-builder';
import { SanitizedLogger } from '../../../src/lib/logger';
import { PhaseRunner } from '../../../src/controller/phase-runner';
import {
  LEDGER_KEY_SEPARATOR,
  POSTURE_LEDGER_MAX_PAIRS,
  type BackendPostureAccessor
} from '../../../src/controller/backend-posture-recorder';
import { MAX_QUEUES } from '../../../src/contracts/queue-bounds';
import { SUPPORTED_BACKENDS } from '../../../src/contracts/backend-kinds';
import { RequiredEvidenceUnavailableError } from '../../../src/lib/errors';
import { ZippedStreamBuffer } from '../../../src/runner/zipped-stream-buffer';
import type { ClaudeCliRunner } from '../../../src/runner/claude-cli';
import type { AuditLogWriter } from '../../../src/audit/audit-log-writer';
import type { AuditEntry } from '../../../src/audit/audit-entry';
import type { RawInvocationOutput } from '../../../src/runner/invocation-result';
import type { PhaseDef } from '../../../src/config/pipeline-config';

// OBSERVED NON-VACUOUS, 2026-08-24, darwin/arm64. Three mutations of
// `controller/backend-posture-recorder.ts`, each reverted afterwards; command in
// every case `npx vitest run tests/unit/controller/phase-runner-backend-posture.test.ts`:
//
//   emission removed          -> 11 of 13 failed
//   posture hard-coded false  ->  2 failed (the payload test and the freshness test)
//   de-duplication removed    ->  2 failed (per-phase and multi-backend)
//
// Restored: 13 passed. The middle one is the one worth keeping: it is the only
// mutation that leaves a record in place while making it untrue, which is the
// exact defect this feature exists to remove.
const POSTURE = 'backend-posture-admitted';

function makeRawOutput(): RawInvocationOutput {
  const stdout = new ZippedStreamBuffer();
  stdout.append('[SCHEGENT_STATUS: CLEAR]');
  stdout.finalize();
  const stderr = new ZippedStreamBuffer();
  stderr.finalize();
  return { stdoutBuffer: stdout, stderrBuffer: stderr, exitCode: 0, killed: false, timedOut: false, durationMs: 5 };
}

function makeFakeRunner(): ClaudeCliRunner {
  return {
    invoke: vi.fn(async () => makeRawOutput()),
    cancelActive: vi.fn(() => false),
    hasActiveProcess: false
  } as unknown as ClaudeCliRunner;
}

type Appended = Omit<AuditEntry, 'id' | 'timestamp'>;

function makeRecordingAuditWriter(
  onAppend?: (entry: Appended) => void
): { writer: AuditLogWriter; entries: Appended[] } {
  const entries: Appended[] = [];
  let counter = 0;
  const writer = {
    append: vi.fn(async (entry: Appended): Promise<AuditEntry> => {
      onAppend?.(entry);
      entries.push(entry);
      return { id: `audit-${++counter}`, timestamp: '2026-08-24T00:00:00Z', ...entry };
    }),
    logPath: '/tmp/.schegent/audit.log'
  } as unknown as AuditLogWriter;
  return { writer, entries };
}

function postureAccessor(read: () => boolean): BackendPostureAccessor {
  return { isUncontainedAllowed: read };
}

function makeRunner(
  writer: AuditLogWriter,
  accessor: BackendPostureAccessor | null
): PhaseRunner {
  return new PhaseRunner(
    makeFakeRunner(),
    new PromptBuilder(),
    writer,
    new SanitizedLogger(),
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    accessor
  );
}

const baseInputs = {
  phase: 'speckit-specify' as const,
  iteration: 1,
  iterationCap: 10,
  featureDescription: 'desc',
  featureDir: 'specs/147-mock',
  cliPath: 'claude',
  cwd: '/repo',
  timeoutMs: 5_000,
  runId: 'run-posture-1'
};

const phaseDefFor = (runner: 'claude' | 'codex' | 'agy'): PhaseDef =>
  ({ id: 'speckit-specify', runner }) as unknown as PhaseDef;

const postureEntries = (entries: Appended[]): Appended[] =>
  entries.filter((e) => e.eventType === POSTURE);

describe('PhaseRunner — backend posture record (FR-R3-064)', () => {
  it('records the backend, its classification, and the posture as read', async () => {
    const { writer, entries } = makeRecordingAuditWriter();
    await makeRunner(writer, postureAccessor(() => true)).run(baseInputs);

    const posture = postureEntries(entries);
    expect(posture).toHaveLength(1);
    expect(posture[0].payload).toEqual({
      runner: 'claude',
      containment: 'none',
      uncontainedAllowed: true
    });
    expect(posture[0].outcome).toBe('info');
    expect(posture[0].runId).toBe('run-posture-1');
  });

  it('orders the record strictly before that phase-start', async () => {
    const { writer, entries } = makeRecordingAuditWriter();
    await makeRunner(writer, postureAccessor(() => true)).run(baseInputs);

    const order = entries.map((e) => e.eventType);
    expect(order.indexOf(POSTURE)).toBeGreaterThanOrEqual(0);
    expect(order.indexOf(POSTURE)).toBeLessThan(order.indexOf('phase-start'));
  });

  it('records once for a multi-phase Run on one backend, not once per phase', async () => {
    const { writer, entries } = makeRecordingAuditWriter();
    const runner = makeRunner(writer, postureAccessor(() => true));

    await runner.run(baseInputs);
    await runner.run({ ...baseInputs, phase: 'speckit-plan', iteration: 2 });
    await runner.run({ ...baseInputs, phase: 'speckit-tasks', iteration: 3 });

    // Three phases, three `phase-start` records, ONE posture record. This is the
    // property the source item's "exactly one per run" is actually about.
    expect(entries.filter((e) => e.eventType === 'phase-start')).toHaveLength(3);
    expect(postureEntries(entries)).toHaveLength(1);
  });

  it('records one entry per distinct backend when a Run overrides per phase', async () => {
    const { writer, entries } = makeRecordingAuditWriter();
    const runner = makeRunner(writer, postureAccessor(() => true));

    await runner.run({ ...baseInputs, phaseDef: phaseDefFor('codex') });
    await runner.run({ ...baseInputs, phase: 'speckit-plan', iteration: 2, phaseDef: phaseDefFor('claude') });
    // A second phase back on `codex` must NOT produce a third entry.
    await runner.run({ ...baseInputs, phase: 'speckit-tasks', iteration: 3, phaseDef: phaseDefFor('codex') });

    const posture = postureEntries(entries);
    expect(posture).toHaveLength(2);
    expect(posture.map((e) => (e.payload as { runner: string }).runner)).toEqual(['codex', 'claude']);
    // Recording only the first kind would leave the manifest sentence false for
    // the second, which is the defect this feature removes.
    expect(posture.map((e) => (e.payload as { containment: string }).containment)).toEqual([
      'os-enforced',
      'none'
    ]);
  });

  it('separates Runs — a second Run on the same backend records its own entry', async () => {
    const { writer, entries } = makeRecordingAuditWriter();
    const runner = makeRunner(writer, postureAccessor(() => true));

    await runner.run(baseInputs);
    await runner.run({ ...baseInputs, runId: 'run-posture-2' });

    expect(postureEntries(entries)).toHaveLength(2);
  });

  it('does not misrecord a contained backend as consent', async () => {
    const { writer, entries } = makeRecordingAuditWriter();
    await makeRunner(writer, postureAccessor(() => true)).run({
      ...baseInputs,
      phaseDef: phaseDefFor('codex')
    });

    const posture = postureEntries(entries);
    expect(posture).toHaveLength(1);
    expect(posture[0].payload).toMatchObject({ runner: 'codex', containment: 'os-enforced' });
    // No entry anywhere in this Run claims an uncontained posture.
    expect(
      posture.filter((e) => (e.payload as { containment: string }).containment === 'none')
    ).toHaveLength(0);
  });

  it('reads the posture fresh at each emission, never once', async () => {
    const { writer, entries } = makeRecordingAuditWriter();
    let allowed = false;
    const runner = makeRunner(writer, postureAccessor(() => allowed));

    await runner.run(baseInputs);
    allowed = true;
    // A different Run, so a new emission — which must reflect the CHANGED value.
    // If the accessor were consulted once and cached, this would still read false.
    await runner.run({ ...baseInputs, runId: 'run-posture-2' });

    const posture = postureEntries(entries);
    expect(posture.map((e) => (e.payload as { uncontainedAllowed: boolean }).uncontainedAllowed)).toEqual([
      false,
      true
    ]);
  });

  it('carries only the three bounded primitives — no path, argv, or free text', async () => {
    const { writer, entries } = makeRecordingAuditWriter();
    await makeRunner(writer, postureAccessor(() => true)).run(baseInputs);

    const payload = postureEntries(entries)[0].payload as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(['containment', 'runner', 'uncontainedAllowed']);
    for (const value of Object.values(payload)) {
      expect(['string', 'boolean']).toContain(typeof value);
    }
    // The two string fields are closed enumerations, not free text.
    expect(['claude', 'codex', 'agy']).toContain(payload.runner);
    expect(['none', 'os-enforced']).toContain(payload.containment);
  });

  it('fails the phase when the record cannot be written, rather than proceeding unrecorded', async () => {
    const { writer } = makeRecordingAuditWriter((entry) => {
      if (entry.eventType === POSTURE) throw new Error('disk full');
    });
    const fakeRunner = makeFakeRunner();
    const runner = new PhaseRunner(
      fakeRunner,
      new PromptBuilder(),
      writer,
      new SanitizedLogger(),
      null, null, null, null, null, null, null,
      postureAccessor(() => true)
    );

    await expect(runner.run(baseInputs)).rejects.toBeInstanceOf(RequiredEvidenceUnavailableError);
    // The point of "required": the backend was never reached.
    expect(fakeRunner.invoke).not.toHaveBeenCalled();
  });

  it('retries the record on the next phase when the first append failed', async () => {
    let fail = true;
    const { writer, entries } = makeRecordingAuditWriter((entry) => {
      if (entry.eventType === POSTURE && fail) throw new Error('transient');
    });
    const runner = makeRunner(writer, postureAccessor(() => true));

    await expect(runner.run(baseInputs)).rejects.toBeInstanceOf(RequiredEvidenceUnavailableError);
    fail = false;
    await runner.run({ ...baseInputs, phase: 'speckit-plan', iteration: 2 });

    // Marking the ledger before a successful append would have turned required
    // evidence into evidence required once and then optional.
    expect(postureEntries(entries)).toHaveLength(1);
  });

  it('emits nothing when no posture accessor is injected', async () => {
    const { writer, entries } = makeRecordingAuditWriter();
    await makeRunner(writer, null).run(baseInputs);

    // Recording `false` for a posture it cannot read would be a lie; production
    // wiring is enforced by `tests/lint/backend-posture-emission-funnel.test.ts`,
    // not by this silence.
    expect(postureEntries(entries)).toHaveLength(0);
  });

  it('keys the ledger unambiguously — no backend kind can contain the separator', () => {
    // If a kind could contain the separator, `runId + sep + kind` would be
    // ambiguous and one Run's entry could satisfy the ledger for another,
    // suppressing a record the setting's description promises. Asserted rather
    // than argued.
    for (const kind of SUPPORTED_BACKENDS) {
      expect(kind.includes(LEDGER_KEY_SEPARATOR)).toBe(false);
    }
  });

  it('does not let one Run suppress another Run\'s record via its id', () => {
    const { writer, entries } = makeRecordingAuditWriter();
    const runner = makeRunner(writer, postureAccessor(() => true));
    // Two ids chosen so that a naive separator would make their keys collide.
    return (async () => {
      await runner.run({ ...baseInputs, runId: 'run-a' });
      await runner.run({ ...baseInputs, runId: `run-a${LEDGER_KEY_SEPARATOR}claude` });
      expect(postureEntries(entries)).toHaveLength(2);
    })();
  });

  it('bounds the ledger above the maximum number of simultaneously live pairs', () => {
    // The cap is derived, not picked. A window cannot have more than MAX_QUEUES
    // Runs in flight (one Task per queue), and one Run can reach at most
    // SUPPORTED_BACKENDS.length distinct kinds — so this product is the ceiling on
    // LIVE pairs, and the cap must clear it or eviction could touch a Run that is
    // still running. Asserted against the two constants rather than against the
    // literal, so widening either fails here instead of quietly eating the margin.
    expect(POSTURE_LEDGER_MAX_PAIRS).toBeGreaterThan(MAX_QUEUES * SUPPORTED_BACKENDS.length);
  });

  it('never omits an entry when the ledger evicts — it can only duplicate', async () => {
    const { writer, entries } = makeRecordingAuditWriter();
    const runner = makeRunner(writer, postureAccessor(() => true));

    // Fill past the cap with distinct Runs, then return to the FIRST one. If
    // eviction could cause a miss, this second visit would be silent.
    const CAP = POSTURE_LEDGER_MAX_PAIRS;
    for (let i = 0; i < CAP + 1; i += 1) {
      await runner.run({ ...baseInputs, runId: `run-fill-${i}` });
    }
    const before = postureEntries(entries).length;
    await runner.run({ ...baseInputs, runId: 'run-fill-0' });

    expect(postureEntries(entries).length).toBe(before + 1);
  }, 30_000);
});
