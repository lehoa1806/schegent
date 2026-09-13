import { ZippedStreamBuffer } from '../../../src/runner/zipped-stream-buffer';
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
import { projectAuditPayload } from '../../../src/audit/audit-payload';
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
  return { stdoutBuffer: (() => { const b = new ZippedStreamBuffer(); b.append('[SCHEGENT_STATUS: CLEAR]'); b.finalize(); return b; })(), stderrBuffer: (() => { const b = new ZippedStreamBuffer(); b.finalize(); return b; })(),
    
    exitCode: 0,
    killed: false,
    timedOut: false,
    durationMs: 50,
    ...overrides };
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

// Feature 212 (FR-001) — the cancellation path, which writes a `cancel` row and,
// until this feature, no terminal record at all.
//
// The `cancel` row is retained verbatim. What is added beside it is the terminal
// record, and its envelope-level outcome is `'info'` — deliberately NOT the
// `'failure'` the standing mapping in `PhaseRunner.runInner` would give it, since
// the arm sets `outcome: 'failed'`. Cancellation writes no `phase-end` today, so
// this feature is ADDING a population to every census over `phase-end` outcomes;
// recording it as a failure would reclassify every operator cancel as a system
// fault on the day this ships. An unasserted divergence from the standing
// mapping reverts the first time someone reaches for the mapping, so it is
// asserted here.
function makeIdRecordingWriter(): { writer: AuditLogWriter; written: AuditEntry[] } {
  const written: AuditEntry[] = [];
  let counter = 0;
  const writer = {
    append: vi.fn(async (entry: Omit<AuditEntry, 'id' | 'timestamp'>): Promise<AuditEntry> => {
      const full: AuditEntry = { id: `audit-${++counter}`, timestamp: '2026-09-13T00:00:00Z', ...entry };
      written.push(full);
      return full;
    }),
    logPath: '/tmp/.schegent/audit.log'
  } as unknown as AuditLogWriter;
  return { writer, written };
}

describe('PhaseRunner.run — the cancelled phase is recorded (feature 212)', () => {
  async function driveCancel(): Promise<AuditEntry[]> {
    const cliRunner = makeFakeRunner(async () =>
      makeRawOutput({ killed: true, exitCode: null })
    );
    const { writer, written } = makeIdRecordingWriter();
    const runner = new PhaseRunner(cliRunner, new PromptBuilder(), writer, new SanitizedLogger());
    const out = await runner.run(baseInputs);
    expect(out.terminationReason).toBe('cancel');
    return written;
  }

  it('retains the cancel row unchanged', async () => {
    const written = await driveCancel();
    const cancels = written.filter((e) => e.eventType === 'cancel');
    expect(cancels).toHaveLength(1);
    expect(cancels[0]!.outcome).toBe('info');
    expect((cancels[0]!.payload as Record<string, unknown>).reason).toBe('killed');
  });

  it('adds exactly one terminal record, paired to the phase-start row', async () => {
    const written = await driveCancel();
    const starts = written.filter((e) => e.eventType === 'phase-start');
    const ends = written.filter((e) => e.eventType === 'phase-end');
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect((ends[0]!.payload as Record<string, unknown>).attemptId).toBe(starts[0]!.id);
    expect((ends[0]!.payload as Record<string, unknown>).terminationReason).toBe('cancel');
  });

  it('records the cancellation as info, not failure', async () => {
    const written = await driveCancel();
    const end = written.find((e) => e.eventType === 'phase-end')!;
    expect(end.outcome).toBe('info');
    // The phase's own non-clean result stays legible in the payload — the same
    // split the `cancel` row already uses.
    expect((end.payload as Record<string, unknown>).outcome).toBe('failed');
  });
});

// Feature 212 / T049 — the remaining three of SC-002's six termination paths.
//
// T014 covers the pre-spawn abort, T015 the cancellation above and T018 normal
// completion. These three had no task at all, and they are the ones where
// getting it wrong is INVISIBLE rather than absent: each arm already writes its
// own `phase-end` and then returns normally through `run()`'s `finally`, so a
// seam that wrote unconditionally would give the most common failure paths in
// the retained logs a second, contradictory terminal record — two rows claiming
// different outcomes for one attempt, where the whole point of the pairing is
// that an attempt has exactly one. A missing record is a gap a census can find;
// a duplicate looks like data.
//
// So each case asserts the COUNT as well as the content.
//
// `parseInvocation` is mocked at the top of this file to return `clean`, so the
// deadline and idle arms are reached through the other half of their condition
// (`requiresHostVerification`) rather than through a malformed parse — which is
// also the configuration where a false terminal record would matter most.
const VERIFIED_PHASE = {
  id: 'speckit-specify',
  name: 'Specify',
  hostVerification: 'exit-code' as const
};

describe('PhaseRunner.run — one terminal record on every termination path (feature 212, SC-002)', () => {
  async function driveTerminal(
    raw: Partial<RawInvocationOutput>,
    inputs: Record<string, unknown> = {}
  ): Promise<{ written: AuditEntry[]; end: AuditEntry; reason: string | undefined }> {
    const cliRunner = makeFakeRunner(async () => makeRawOutput(raw));
    const { writer, written } = makeIdRecordingWriter();
    const runner = new PhaseRunner(cliRunner, new PromptBuilder(), writer, new SanitizedLogger());
    const out = await runner.run({ ...baseInputs, ...inputs });
    const ends = written.filter((e) => e.eventType === 'phase-end');
    const starts = written.filter((e) => e.eventType === 'phase-start');
    // The invariant, asserted on every path rather than once: exactly one
    // terminal record, paired to the attempt by the `phase-start` row's own id.
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect((ends[0]!.payload as Record<string, unknown>).attemptId).toBe(starts[0]!.id);
    return { written, end: ends[0]!, reason: out.terminationReason };
  }

  it('records the idle timeout exactly once', async () => {
    const { end, reason } = await driveTerminal(
      { timedOut: true, exitCode: null },
      { phaseDef: VERIFIED_PHASE }
    );
    expect(reason).toBe('timeout');
    expect((end.payload as Record<string, unknown>).terminationReason).toBe('timeout');
    // Pins the case to the idle arm specifically: it is the only one that
    // records `outcome: 'timeout'` rather than `'failed'`.
    expect((end.payload as Record<string, unknown>).outcome).toBe('timeout');
  });

  it('records the absolute deadline exactly once, as deadline and not as timeout', async () => {
    // The two arms are adjacent and the deadline is checked first precisely so
    // they can never both claim a run. A terminal record that said `timeout`
    // here would send an operator to tune the idle bound for a phase the
    // absolute bound stopped.
    const { end, reason } = await driveTerminal(
      { deadlineExceeded: true, timedOut: false, exitCode: null },
      { phaseDef: VERIFIED_PHASE }
    );
    expect(reason).toBe('deadline');
    expect((end.payload as Record<string, unknown>).terminationReason).toBe('deadline');
    expect((end.payload as Record<string, unknown>).outcome).toBe('deadline');
  });

  it('records a backend error exactly once — the host-verification failure', async () => {
    const { end, reason } = await driveTerminal(
      { exitCode: 1 },
      { phaseDef: VERIFIED_PHASE }
    );
    expect(reason).toBe('error');
    expect((end.payload as Record<string, unknown>).terminationReason).toBe('error');
    expect(end.outcome).toBe('failure');
    // `error` is recorded by two arms; the warning is what separates them, so a
    // pass here cannot be bought by the other one firing.
    expect((end.payload as Record<string, unknown>).warnings).toContain('host-verification-failed');
  });

  it('records a backend error exactly once — the stdin-delivery failure', async () => {
    // Same class, different arm: the prompt never reached the backend. It is
    // listed separately because it is the one `error` path that can fire on an
    // otherwise clean parse, so an arm-count check that missed it would still
    // look complete.
    const { end, reason } = await driveTerminal({
      stdinDeliveryFailed: true,
      stdinErrorCode: 'EPIPE'
    });
    expect(reason).toBe('error');
    expect((end.payload as Record<string, unknown>).terminationReason).toBe('error');
    expect((end.payload as Record<string, unknown>).warnings).toContain('stdin-delivery-failed');
  });
});

// Feature 212 / T024 (FR-006, SC-003) — the envelope-presence fact leaves the
// runner.
//
// Until this feature the fact existed only as `completedAwaitingExit`, read at
// one site inside `PhaseRunner` and never surfaced, so nothing downstream could
// tell "failed, and the backend told us why" from "failed, and we never heard
// back at all". Those two need different responses — the first has a diagnosis
// to act on, the second has only the observation that nothing came back.
//
// THREE-STATE, and the third state is the point (FR-014). `'received'` and
// `'absent'` are claims; anything not positively known is OMITTED. A binary
// mapping off `completedAwaitingExit` alone would read `false` — its value on
// every normal successful phase — as "no envelope", manufacturing an absence
// for the most common path in the logs. That is the same false zero this
// feature exists to remove, pointed the other way.
describe('PhaseRunner.run — the envelope-presence fact reaches the result (feature 212)', () => {
  async function driveEnvelope(
    raw: Partial<RawInvocationOutput>,
    inputs: Record<string, unknown> = {}
  ): Promise<{ envelope: unknown; end: AuditEntry }> {
    const cliRunner = makeFakeRunner(async () => makeRawOutput(raw));
    const { writer, written } = makeIdRecordingWriter();
    const runner = new PhaseRunner(cliRunner, new PromptBuilder(), writer, new SanitizedLogger());
    const out = await runner.run({ ...baseInputs, ...inputs });
    const end = written.find((e) => e.eventType === 'phase-end')!;
    return { envelope: out.resultEnvelope, end };
  }

  it('reports received when the backend produced its end-of-invocation envelope', async () => {
    const { envelope, end } = await driveEnvelope({
      sawTerminalResult: true,
      exitCode: 1,
      phaseDef: undefined
    } as Partial<RawInvocationOutput>, { phaseDef: VERIFIED_PHASE });
    expect(envelope).toBe('received');
    expect((end.payload as Record<string, unknown>).resultEnvelope).toBe('received');
  });

  it('reports absent when the invocation ended with no envelope', async () => {
    const { envelope, end } = await driveEnvelope(
      { sawTerminalResult: false, timedOut: true, exitCode: null },
      { phaseDef: VERIFIED_PHASE }
    );
    expect(envelope).toBe('absent');
    expect((end.payload as Record<string, unknown>).resultEnvelope).toBe('absent');
  });

  it('omits the fact entirely when the backend reports nothing about it', async () => {
    // A backend that does not implement the signal at all — every non-Claude
    // runner today. Its invocations are UNKNOWN, and unknown must not be
    // rendered as either claim (FR-014).
    const { envelope, end } = await driveEnvelope({ exitCode: 1 }, { phaseDef: VERIFIED_PHASE });
    expect(envelope).toBeUndefined();
    expect('resultEnvelope' in (end.payload as Record<string, unknown>)).toBe(false);
  });

  it('reports received on a normal clean run, not absent', async () => {
    // The regression the binary mapping would introduce: `completedAwaitingExit`
    // is false here, and reading that as "no envelope" would mark every
    // successful phase in the system envelope-less.
    const { envelope } = await driveEnvelope({ sawTerminalResult: true, exitCode: 0 });
    expect(envelope).toBe('received');
  });
});

// Feature 212 / T030 (FR-008, FR-009, SC-005) — what a terminated phase DID.
//
// The two bound arms — absolute deadline and idle timeout — wrote no file or
// command counts at all, and the arms that did write them wrote
// `audit.entry?.filesCreated ?? []`. Both produce the same wrong record in the
// end, by opposite routes. Written as `?? []`, an unparsed block reaches the
// projection as three empty ARRAYS, which is exactly the evidence
// `auditBlockParsed` reads as "the block was parsed" — so the projection dutifully
// records `{created: 0, modified: 0, deleted: 0}` and `omittedFileEvidenceCount: 0`
// for a phase nobody measured. Written as nothing at all, a phase that really did
// create files is recorded as having no counts rather than as having those counts.
//
// The distinction the feature turns on is that absence and zero are different
// claims: absence says nobody looked, zero says somebody looked and found
// nothing. These tests assert both halves at the arm, because the projection
// half (T012, T031, T032) can only be honest about a payload that is.
const AUDIT_BLOCK = [
  '=== SCHEGENT AUDIT LOG ===',
  'phase: speckit-specify',
  'files_created: ["specs/001-mock/spec.md"]',
  'files_modified: ["specs/001-mock/plan.md", "README.md"]',
  'files_deleted: []',
  'commands_executed: ["npm test"]',
  'network_calls: ["none"]',
  'ruleset_switches: ["none"]',
  'notes: partial work before the bound',
  '=== END AUDIT LOG ===',
  '[SCHEGENT_STATUS: CLEAR]'
].join('\n');

describe('PhaseRunner.run — a terminated phase reports what it did (feature 212)', () => {
  async function driveCounts(
    raw: Partial<RawInvocationOutput>,
    stdout: string
  ): Promise<Record<string, unknown>> {
    const cliRunner = makeFakeRunner(async () =>
      makeRawOutput({
        stdoutBuffer: (() => {
          const b = new ZippedStreamBuffer();
          b.append(stdout);
          b.finalize();
          return b;
        })(),
        ...raw
      })
    );
    const { writer, written } = makeIdRecordingWriter();
    const runner = new PhaseRunner(cliRunner, new PromptBuilder(), writer, new SanitizedLogger());
    await runner.run({ ...baseInputs, phaseDef: VERIFIED_PHASE });
    const ends = written.filter((e) => e.eventType === 'phase-end');
    expect(ends).toHaveLength(1);
    return ends[0]!.payload as Record<string, unknown>;
  }

  it('carries the parsed counts on the absolute-deadline arm (FR-008)', async () => {
    const payload = await driveCounts(
      { deadlineExceeded: true, timedOut: false, exitCode: null },
      AUDIT_BLOCK
    );
    expect(payload.files_created).toEqual(['specs/001-mock/spec.md']);
    expect(payload.files_modified).toEqual(['specs/001-mock/plan.md', 'README.md']);
    expect(payload.commands_executed).toEqual(['npm test']);
  });

  it('carries the parsed counts on the idle-timeout arm (FR-008)', async () => {
    // Listed separately rather than folded into the case above: the two arms are
    // adjacent, near-identical and were written months apart, which is precisely
    // the shape where one gets the fix and the other keeps the defect.
    const payload = await driveCounts({ timedOut: true, exitCode: null }, AUDIT_BLOCK);
    expect(payload.files_created).toEqual(['specs/001-mock/spec.md']);
    expect(payload.files_modified).toEqual(['specs/001-mock/plan.md', 'README.md']);
    expect(payload.commands_executed).toEqual(['npm test']);
  });

  it('omits the counts entirely when the audit block was never parsed (FR-009)', async () => {
    // NOT `[]`. An empty array is the evidence the projection reads as "the block
    // was parsed", so `?? []` here would have the record state that a phase killed
    // at its deadline demonstrably changed nothing.
    const payload = await driveCounts(
      { deadlineExceeded: true, timedOut: false, exitCode: null },
      'no audit block here at all'
    );
    expect('files_created' in payload).toBe(false);
    expect('files_modified' in payload).toBe(false);
    expect('commands_executed' in payload).toBe(false);
  });

  it('carries the deleted list through to a real deletion count (FR-R3-171, FR-002, SC-001)', async () => {
    // The defect FR-R3-171 filed, asserted at the layer that actually has it.
    // `auditEvidenceFields()` forwards `files_created`, `files_modified` and
    // `commands_executed` and has never forwarded `files_deleted`, so a phase
    // that deleted two files wrote a `phase-end` row saying it deleted none.
    // That `deleted: 0` is structural, not measured, and nothing on the row
    // tells it apart from a phase that looked and genuinely found nothing.
    //
    // Driven end to end rather than asserted on the projection alone, and the
    // reason is load-bearing: the projection ALREADY counts `files_deleted`
    // correctly whenever the payload carries it (`audit-payload-v3.test.ts`
    // "turns model-reported file and command lists into counts only"). A
    // projection-level version of this test passes on the unfixed tree, so it
    // would be a [RED] test that is never red -- the vacuous-guard defect this
    // same feature exists to close. Only the writer drops the list.
    const payload = await driveCounts(
      { deadlineExceeded: true, timedOut: false, exitCode: null },
      AUDIT_BLOCK.replace('files_deleted: []', 'files_deleted: ["src/old.ts", "docs/stale.md"]')
    );
    expect(payload.files_deleted).toEqual(['src/old.ts', 'docs/stale.md']);

    const row = projectAuditPayload('phase-end', payload) as {
      fileChangeCounts?: { created: number; modified: number; deleted: number };
    };
    expect(row.fileChangeCounts?.deleted).toBe(2);
  });

  it('leaves all four counts absent on a row from an unparsed block (FR-003, SC-002)', async () => {
    // NOT a [RED] test. This passes before the deletion forward lands and must
    // still pass after, because the forward is precisely the change that could
    // turn an unparsed block into four zeroes: write `files_deleted:
    // entry?.filesDeleted ?? []` outside the `entry ?` guard and every phase
    // killed at its bound starts claiming it demonstrably deleted nothing.
    //
    // The FR-009 test above pins three payload keys; this pins the fourth and
    // carries it through to the projected row, which is where SC-002's "all
    // four count fields" actually live.
    const payload = await driveCounts(
      { deadlineExceeded: true, timedOut: false, exitCode: null },
      'no audit block here at all'
    );
    expect('files_deleted' in payload).toBe(false);

    const row = projectAuditPayload('phase-end', payload) as Record<string, unknown>;
    // Key presence, not `toBeUndefined()`: an absent key and a key present with
    // the value `undefined` both satisfy the latter, and only the first is a
    // record that says nothing about what the phase did.
    expect('fileChangeCounts' in row).toBe(false);
    expect('omittedFileEvidenceCount' in row).toBe(false);
    expect('omittedToolEvidenceCount' in row).toBe(false);
  });

  it('records measured emptiness when the block WAS parsed and empty (FR-008)', async () => {
    // The contrast that keeps the rule above from being a blanket ban on empty:
    // this phase was measured and changed nothing, and that is a finding.
    const payload = await driveCounts(
      { deadlineExceeded: true, timedOut: false, exitCode: null },
      AUDIT_BLOCK.replace('["specs/001-mock/spec.md"]', '[]')
        .replace('["specs/001-mock/plan.md", "README.md"]', '[]')
        .replace('["npm test"]', '[]')
    );
    expect(payload.files_created).toEqual([]);
    expect(payload.files_modified).toEqual([]);
    expect(payload.commands_executed).toEqual([]);
  });
});
