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
import { UncontainedBackendRefusedError } from '../../../src/services/backend-containment-policy';
import { CapabilityNotEnforceableError } from '../../../src/services/capability-refusal';
import { PRE_SPAWN_REFUSAL_CAUSE } from '../../../src/audit/audit-payload';
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

/**
 * FR-R3-125 — the accessor takes the backend kind now, because the setting is a
 * list. These stubs answer the same for every kind; the per-kind behaviour is
 * asserted in `backend-containment-policy.test.ts` against `resolveUncontainedGrant`,
 * which is where the setting is actually read.
 */
function postureAccessor(read: () => boolean): BackendPostureAccessor {
  return { isUncontainedAllowed: () => read() };
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
      // FR-R3-125 — `none` is a VALUE. An absent field is what a pre-FR-R3-125
      // log looks like, and "uncontained" must stay distinguishable from
      // "not recorded".
      containmentMechanism: 'none',
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
    expect(Object.keys(payload).sort()).toEqual([
      'containment',
      'containmentMechanism',
      'runner',
      'uncontainedAllowed'
    ]);
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

// Feature 212 (FR-001, FR-004, FR-008, FR-009) — the refusal that left no record.
//
// A containment refusal is thrown by `resolveRunner()`, which `PhaseRunner.runInner`
// calls INSIDE the invocation try, whose catch re-throws. So it lands
// after `phase-start` and before `cli-invocation`: the attempt is on disk, the
// spawn never happened, and until this feature nothing closed it. The absence of
// the `cli-invocation` row is what located the throw in the retained logs, so it
// is asserted here rather than left implied.
describe('PhaseRunner — the pre-spawn refusal is recorded (feature 212)', () => {
  function refusingRegistry(): unknown {
    return {
      getOrCreate: vi.fn(() => {
        throw new UncontainedBackendRefusedError('codex', 'no containment available');
      }),
      getGlobalDefault: vi.fn(() => 'codex'),
      observedCliVersion: vi.fn(async () => null)
    };
  }

  function writtenRecordingWriter(): { writer: AuditLogWriter; written: AuditEntry[] } {
    const written: AuditEntry[] = [];
    let counter = 0;
    const writer = {
      append: vi.fn(async (entry: Appended): Promise<AuditEntry> => {
        const full: AuditEntry = { id: `audit-${++counter}`, timestamp: '2026-09-13T00:00:00Z', ...entry };
        written.push(full);
        return full;
      }),
      logPath: '/tmp/.schegent/audit.log'
    } as unknown as AuditLogWriter;
    return { writer, written };
  }

  async function driveRefusal(): Promise<{ written: AuditEntry[]; error: unknown }> {
    const { writer, written } = writtenRecordingWriter();
    const runner = new PhaseRunner(
      refusingRegistry() as never,
      new PromptBuilder(),
      writer,
      new SanitizedLogger()
    );
    let error: unknown = null;
    try {
      await runner.run({ ...baseInputs, phaseDef: phaseDefFor('codex') });
    } catch (err) {
      error = err;
    }
    return { written, error };
  }

  it('closes the attempt with exactly one terminal record paired to the phase-start row', async () => {
    const { written } = await driveRefusal();
    const starts = written.filter((e) => e.eventType === 'phase-start');
    const ends = written.filter((e) => e.eventType === 'phase-end');
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect((ends[0]!.payload as Record<string, unknown>).attemptId).toBe(starts[0]!.id);
  });

  it('records the pre-spawn cause, an UNKNOWN envelope, and a failure outcome', async () => {
    const { written } = await driveRefusal();
    const end = written.find((e) => e.eventType === 'phase-end')!;
    const payload = end.payload as Record<string, unknown>;
    expect(payload.terminationReason).toBe('pre_spawn_refusal');
    expect(payload.cause).toBe(PRE_SPAWN_REFUSAL_CAUSE);
    // NOT `'absent'`. Three contracts define that value as the positive claim
    // that the invocation RAN and no envelope arrived (`PhaseRunOutput.resultEnvelope`,
    // `invocation-result.ts`, `workflow-run.ts`). No child existed here, so the
    // key is omitted and means UNKNOWN (FR-014) — recording `'absent'` would put
    // every refusal into the population FR-007 counts as ran-without-a-verdict.
    expect('resultEnvelope' in payload).toBe(false);
    // The envelope-level verdict, asserted rather than left as a comment.
    expect(end.outcome).toBe('failure');
  });

  it('records no file or command counts for a phase that never ran (FR-009)', async () => {
    const { written } = await driveRefusal();
    const payload = written.find((e) => e.eventType === 'phase-end')!.payload as Record<string, unknown>;
    // A zero here would read as "demonstrably changed nothing", which is a
    // different and false statement about a phase that never started.
    expect('files_created' in payload).toBe(false);
    expect('files_modified' in payload).toBe(false);
    expect('commands_executed' in payload).toBe(false);
    expect('fileChangeCounts' in payload).toBe(false);
  });

  it('still propagates the refusal, and writes no cli-invocation row', async () => {
    const { written, error } = await driveRefusal();
    expect(error).toBeInstanceOf(UncontainedBackendRefusedError);
    expect(written.filter((e) => e.eventType === 'cli-invocation')).toHaveLength(0);
  });
});

// Feature 212 (FR-001, FR-003, FR-004) — the third termination path.
//
// The containment refusal above and the cancellation in `phase-runner-outcome`
// each had a test; a throw OUT OF `invoke()` had none, and it is the path whose
// classification is the most delicate. A throw from inside `invoke()` MAY have
// left a child alive, so it must stay `error` — but a capability refusal is
// raised while the argv is still being assembled and provably has no child, so
// it must not. Nothing pinned either half, and a refactor of that seam would
// have flipped both silently.
describe('PhaseRunner — a throw out of invoke() (feature 212)', () => {
  function throwingRunner(error: Error): ClaudeCliRunner {
    return {
      invoke: vi.fn(async () => {
        throw error;
      }),
      cancelActive: vi.fn(() => false),
      hasActiveProcess: false
    } as unknown as ClaudeCliRunner;
  }

  async function drive(error: Error): Promise<{ written: Appended[]; thrown: unknown }> {
    const { writer, entries } = makeRecordingAuditWriter();
    const runner = new PhaseRunner(
      throwingRunner(error) as never,
      new PromptBuilder(),
      writer,
      new SanitizedLogger()
    );
    let thrown: unknown = null;
    try {
      await runner.run({ ...baseInputs, runId: 'run-invoke-throw' });
    } catch (err) {
      thrown = err;
    }
    return { written: entries, thrown };
  }

  const endOf = (written: Appended[]): Record<string, unknown> =>
    written.find((e) => e.eventType === 'phase-end')!.payload as Record<string, unknown>;

  it('closes the attempt with exactly one terminal record', async () => {
    const { written, thrown } = await drive(new Error('backend blew up'));
    expect(thrown).toBeInstanceOf(Error);
    expect(written.filter((e) => e.eventType === 'phase-start')).toHaveLength(1);
    expect(written.filter((e) => e.eventType === 'phase-end')).toHaveLength(1);
  });

  it('records `error`, not a refusal that may have left a child alive', async () => {
    const payload = endOf((await drive(new Error('backend blew up'))).written);
    expect(payload.terminationReason).toBe('error');
    // The conservative direction, and the whole reason the seam claims a refusal
    // only where an error type names itself one: this throw names nothing, and a
    // child may be alive behind it.
    expect('cause' in payload).toBe(false);
  });

  it('omits the envelope fact rather than guessing it after a spawn', async () => {
    const payload = endOf((await drive(new Error('backend blew up'))).written);
    expect('resultEnvelope' in payload).toBe(false);
  });

  it('classifies a capability refusal as pre-spawn, since the argv never finished', async () => {
    // Raised by `capabilityArgs()` during argv assembly in every adapter —
    // claude-cli `:336` vs its spawn at `:390`, codex-cli `:84`, agy-cli `:121`.
    // No child can exist, so the flag set before `invoke()` over-claims and the
    // catch retracts it. Without that retraction an operator censusing
    // `cause == pre_spawn_refusal` never sees this population at all.
    // A refusal the enforcement plan actually produces: `agy` expresses only
    // `process-spawn`, so a phase withholding `network` is refused
    // (`capability-enforcement-plan.ts` SURFACES.agy).
    const { written } = await drive(new CapabilityNotEnforceableError('agy', ['network']));
    const payload = endOf(written);
    expect(payload.terminationReason).toBe('pre_spawn_refusal');
    expect(payload.cause).toBe(PRE_SPAWN_REFUSAL_CAUSE);
    expect('resultEnvelope' in payload).toBe(false);
  });
});

// Feature 212 (FR-003) — the append that lands after the caller gave up.
//
// `AuditLogWriter.append` is bounded for the CALLER (`APPEND_TIMEOUT_MS`), and
// `src/lib/io-barrier.ts` says what that bound means: a rejection says "you were
// not told this landed", not that the write was abandoned. An arm that claimed
// the attempt only after a successful append therefore left it open for a row
// already on its way to disk, and the `finally` seam wrote a SECOND terminal
// record for the same `attemptId` — one `success`, one `error/failed`, with no
// way for a reader to tell which is the verdict. That is strictly worse than the
// gap this feature removes, so the claim happens before the append.
describe('PhaseRunner — a phase-end append that rejects (feature 212)', () => {
  it('never writes a second terminal record for an attempt whose row may have landed', async () => {
    const attempted: string[] = [];
    let counter = 0;
    const writer = {
      append: vi.fn(async (entry: Appended): Promise<AuditEntry> => {
        attempted.push(entry.eventType);
        if (entry.eventType === 'phase-end') {
          // Verbatim the shape `boundForCaller` produces at the 5 s bound.
          throw new Error('audit append timed out after 5000ms');
        }
        return { id: `audit-${++counter}`, timestamp: '2026-09-13T00:00:00Z', ...entry };
      }),
      logPath: '/tmp/.schegent/audit.log'
    } as unknown as AuditLogWriter;

    const runner = new PhaseRunner(
      makeFakeRunner() as never,
      new PromptBuilder(),
      writer,
      new SanitizedLogger()
    );
    await expect(
      runner.run({ ...baseInputs, runId: 'run-phase-end-reject' })
    ).rejects.toBeInstanceOf(RequiredEvidenceUnavailableError);

    // ONE attempt, not two. The count is of appends TRIED, not appends stored:
    // the point is that the seam never reached for a second row, and a stored
    // count cannot see that because neither row is stored.
    expect(attempted.filter((e) => e === 'phase-end')).toHaveLength(1);
  });
});

// Feature 212 (FR-004) — a failed audit write is not a policy decision.
//
// The seam classified every throw by POSITION: one boolean, "did control reach
// `invoke()`", with `pre_spawn_refusal` as the default for everything before it.
// But `pre_spawn_refusal` and `PRE_SPAWN_REFUSAL_CAUSE` are a positive claim
// about WHY the phase stopped — the backend was refused on policy grounds — and
// the window before the flag is set holds work that has nothing to do with
// policy: two audit appends, the raw-transcript start, the capture handle, the
// operator fatal-signature read. Each throws on its own account, and each was
// written down as a refusal that never happened.
//
// The audit append is the one that matters most, because it inverts the record's
// own meaning: `appendRequiredAudit` converts a refused write into a
// `RequiredEvidenceUnavailableError`, so a transient outage of the evidence sink
// became a DURABLE statement that an operator's containment policy stopped the
// phase. An incident review censusing `cause == pre_spawn_refusal` reads a
// backend-posture problem and never learns the log could not be written.
//
// So the classification is by error TYPE now — the same lesson the capability
// refusal taught one line into the catch above, applied to the whole window
// rather than to one call. The two refusals name themselves; everything else is
// `error`, which is what an unclassified throw has always meant.
describe('PhaseRunner — a pre-spawn throw that is not a refusal (feature 212)', () => {
  async function driveAuditFailure(): Promise<{ entries: Appended[]; thrown: unknown }> {
    const entries: Appended[] = [];
    let counter = 0;
    const writer = {
      append: vi.fn(async (entry: Appended): Promise<AuditEntry> => {
        // The optional-evidence row written between `phase-start` and the spawn.
        // Any of the window's calls would do; this one is reachable with a single
        // accessor and needs no runner that half-succeeds.
        if (entry.eventType === 'auto-compact-override-applied') {
          throw new Error('audit append timed out after 5000ms');
        }
        entries.push(entry);
        return { id: `audit-${++counter}`, timestamp: '2026-09-13T00:00:00Z', ...entry };
      }),
      logPath: '/tmp/.schegent/audit.log'
    } as unknown as AuditLogWriter;

    const runner = new PhaseRunner(
      makeFakeRunner() as never,
      new PromptBuilder(),
      writer,
      new SanitizedLogger(),
      null,
      null,
      null,
      { readAutoCompactPctOverride: () => 80 }
    );
    let thrown: unknown = null;
    try {
      await runner.run({ ...baseInputs, runId: 'run-pre-spawn-audit-failure' });
    } catch (err) {
      thrown = err;
    }
    return { entries, thrown };
  }

  it('records `error` for an audit-write failure, not a refusal nobody made', async () => {
    const { entries, thrown } = await driveAuditFailure();
    // The window is genuinely entered and the throw is genuinely the audit one —
    // asserted, so a future edit that stops reaching this line fails here rather
    // than passing the classification test vacuously.
    expect(thrown).toBeInstanceOf(RequiredEvidenceUnavailableError);

    const end = entries.find((e) => e.eventType === 'phase-end');
    expect(end).toBeDefined();
    const payload = end!.payload as Record<string, unknown>;
    expect(payload.terminationReason).toBe('error');
    // And no `cause`. Writing one here would not merely mislabel the reason: it
    // would put this row into the very census `PRE_SPAWN_REFUSAL_CAUSE` exists to
    // make countable, where every member is supposed to be a policy refusal.
    expect('cause' in payload).toBe(false);
  });

  it('still closes the attempt, paired to its phase-start row (FR-001, FR-002)', async () => {
    const { entries } = await driveAuditFailure();
    const starts = entries.filter((e) => e.eventType === 'phase-start');
    const ends = entries.filter((e) => e.eventType === 'phase-end');
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    // The misclassification fix must not cost the terminal record itself: the
    // gap FR-001 closes is the row being absent, and `error` vs `pre_spawn_refusal`
    // is a question that only arises once the row is there.
    expect((ends[0]!.payload as Record<string, unknown>).attemptId).toBe('audit-1');
  });
});
