// Feature 212 — the pairing invariant the recorder exists to hold.
//
// FR-001/FR-002: every recorded attempt to run a phase is followed by exactly
// one terminal record, paired by the `phase-start` row's own `AuditEntry.id`
// rather than by position or by the `(runId, phase, iteration)` triple — which
// the retained logs prove is not unique (SC-008).
//
// FR-011: the terminal record must not depend on optional diagnostics. That is
// asserted here structurally as well as behaviourally — the recorder is
// constructed with an append and a logger and nothing else, so there is no
// verbose setting, stream reader or diagnostics sink it could come to need. A
// backend that produces no diagnostics at all still gets its record.

import { describe, it, expect, vi } from 'vitest';
import {
  PhaseAttemptRecorder,
  terminalAuditOutcome,
  type AttemptAuditContext
} from '../../../src/controller/phase-attempt-recorder';
import type { AuditEntry } from '../../../src/audit/audit-entry';

interface Harness {
  readonly recorder: PhaseAttemptRecorder;
  readonly entries: AuditEntry[];
  readonly warnings: string[];
}

function makeHarness(appendFails = false): Harness {
  let counter = 0;
  const entries: AuditEntry[] = [];
  const warnings: string[] = [];
  const appendRequired = vi.fn(
    async (entry: Omit<AuditEntry, 'id' | 'timestamp'>): Promise<AuditEntry> => {
      if (appendFails && entry.eventType === 'phase-end') {
        throw new Error('audit writer unavailable');
      }
      const written: AuditEntry = {
        id: `audit-${++counter}`,
        timestamp: '2026-09-13T00:00:00Z',
        ...entry
      };
      entries.push(written);
      return written;
    }
  );
  return {
    recorder: new PhaseAttemptRecorder(appendRequired, {
      warn: (message: string) => warnings.push(message)
    }),
    entries,
    warnings
  };
}

const CONTEXT: AttemptAuditContext = {
  runId: 'run-1',
  phase: 'speckit-specify',
  iteration: 1
};

function terminalRecords(entries: readonly AuditEntry[]): AuditEntry[] {
  return entries.filter((entry) => entry.eventType === 'phase-end');
}

function startRecords(entries: readonly AuditEntry[]): AuditEntry[] {
  return entries.filter((entry) => entry.eventType === 'phase-start');
}

function attemptIdOf(entry: AuditEntry): unknown {
  return (entry.payload as Record<string, unknown>).attemptId;
}

describe('PhaseAttemptRecorder — pairing invariant (FR-001, FR-002, FR-011)', () => {
  it('pairs every attempt with exactly one terminal record, on a default installation', async () => {
    // No verbose accessor, no stream diagnostics, no sidecar — the recorder
    // takes none. This is the installation FR-011 names: the records below are
    // written because the attempt was recorded, not because diagnostics were on.
    const { recorder, entries } = makeHarness();
    const phases = ['speckit-specify', 'speckit-plan', 'speckit-tasks'];
    for (const phase of phases) {
      const attempt = await recorder.begin({ ...CONTEXT, phase }, { phaseId: phase });
      await attempt.close({ outcome: 'clean', terminationReason: 'token' });
    }

    const starts = startRecords(entries);
    const terminals = terminalRecords(entries);
    expect(starts).toHaveLength(3);
    expect(terminals).toHaveLength(3);

    // Paired by identifier, never by order: sort both sides so a correct
    // implementation that interleaved writes would still pass, and an
    // implementation that paired positionally gains nothing.
    const startIds = starts.map((entry) => entry.id).sort();
    const pairedIds = terminals.map((entry) => attemptIdOf(entry) as string).sort();
    expect(pairedIds).toEqual(startIds);
    expect(new Set(pairedIds).size).toBe(3);
  });

  it('reports four attempts under one runId/phase/iteration triple, not one (SC-008)', async () => {
    // `21d88fae` / `speckit-specify` / iteration 1 carries four attempts in the
    // retained logs. Keyed on the triple they collapse to one; keyed on the
    // `phase-start` row's id they stay four, which is what FR-002 requires.
    const { recorder, entries } = makeHarness();
    for (let i = 0; i < 4; i += 1) {
      const attempt = await recorder.begin(CONTEXT, { phaseId: CONTEXT.phase });
      await attempt.close({ outcome: 'failed', terminationReason: 'error' });
    }

    const starts = startRecords(entries);
    const terminals = terminalRecords(entries);
    expect(starts).toHaveLength(4);
    expect(terminals).toHaveLength(4);
    expect(new Set(starts.map((entry) => entry.id)).size).toBe(4);
    expect(terminals.map((entry) => attemptIdOf(entry)).sort()).toEqual(
      starts.map((entry) => entry.id).sort()
    );

    // The triple itself is unchanged on every row — the point of the case.
    for (const entry of entries) {
      expect(entry.runId).toBe('run-1');
      expect(entry.phase).toBe('speckit-specify');
      expect(entry.iteration).toBe(1);
    }
  });

  it('takes the attempt identifier from the phase-start row rather than minting one', async () => {
    const { recorder, entries } = makeHarness();
    const attempt = await recorder.begin(CONTEXT, { phaseId: CONTEXT.phase });
    expect(attempt.attemptId).toBe(startRecords(entries)[0]!.id);
    await attempt.close({ outcome: 'clean', terminationReason: 'token' });
    expect(attemptIdOf(terminalRecords(entries)[0]!)).toBe(attempt.attemptId);
  });

  it('does not proceed unrecorded when the phase-start append fails', async () => {
    // Deliberately uncontained: a phase whose attempt cannot be recorded must
    // not run. It also keeps the invariant TRUE rather than merely enforced —
    // an attempt that was never recorded needs no terminal record to pair with.
    const recorder = new PhaseAttemptRecorder(
      async () => {
        throw new Error('audit writer unavailable');
      },
      { warn: () => undefined }
    );
    await expect(recorder.begin(CONTEXT, {})).rejects.toThrow('audit writer unavailable');
  });
});

describe('PhaseAttempt — exactly once (FR-003, hard rule 9)', () => {
  it('writes no second terminal record when a late result arrives', async () => {
    const { recorder, entries } = makeHarness();
    const attempt = await recorder.begin(CONTEXT, {});
    const first = await attempt.close({ outcome: 'failed', terminationReason: 'timeout' });
    const late = await attempt.close({ outcome: 'clean', terminationReason: 'token' });

    expect(first).not.toBeNull();
    expect(late).toBeNull();
    expect(terminalRecords(entries)).toHaveLength(1);
    // Rule 9 — the first record is not edited by the late arrival either.
    const payload = terminalRecords(entries)[0]!.payload as Record<string, unknown>;
    expect(payload.outcome).toBe('failed');
    expect(payload.terminationReason).toBe('timeout');
  });

  it('lets a caller that wrote its own terminal record claim the attempt', async () => {
    // The five arms of `PhaseRunner.run()` that already append their own
    // `phase-end` keep doing so; this is how the shared seam learns not to
    // write a second one.
    const { recorder, entries } = makeHarness();
    const attempt = await recorder.begin(CONTEXT, {});
    expect(attempt.isClosed).toBe(false);
    expect(attempt.markClosedBy('audit-own')).toBe(true);
    expect(attempt.isClosed).toBe(true);
    expect(attempt.terminalEntryId).toBe('audit-own');

    expect(await attempt.close({ outcome: 'failed', terminationReason: 'error' })).toBeNull();
    expect(attempt.markClosedBy('audit-other')).toBe(false);
    expect(attempt.terminalEntryId).toBe('audit-own');
    expect(terminalRecords(entries)).toHaveLength(0);
  });

  it('claims the attempt before awaiting, so two concurrent closes cannot both write', async () => {
    // Not "unlikely to both write" — impossible. The flag is set synchronously
    // ahead of the append, so the loser is refused deterministically instead of
    // racing through a write the winner is already inside.
    const { recorder, entries } = makeHarness();
    const attempt = await recorder.begin(CONTEXT, {});
    const [a, b] = await Promise.all([
      attempt.close({ outcome: 'failed', terminationReason: 'error' }),
      attempt.close({ outcome: 'clean', terminationReason: 'token' })
    ]);
    expect([a, b].filter((entry) => entry !== null)).toHaveLength(1);
    expect(terminalRecords(entries)).toHaveLength(1);
  });

  it('never retries after a failed append, because a duplicate is worse than a gap', async () => {
    // A throw may or may not have reached disk. FR-003 forbids order-based
    // pairing precisely so a missing record stays detectable; a second one
    // would not be.
    const { recorder, warnings } = makeHarness(true);
    const attempt = await recorder.begin(CONTEXT, {});
    expect(await attempt.close({ outcome: 'failed', terminationReason: 'error' })).toBeNull();
    expect(attempt.isClosed).toBe(true);
    expect(await attempt.close({ outcome: 'failed', terminationReason: 'error' })).toBeNull();
    expect(warnings).toHaveLength(1);
  });
});

describe('PhaseAttempt.close — never masks an in-flight error (FR-001, T022)', () => {
  it('surfaces a failed terminal write as a diagnostic carrying the identifier, not the payload', async () => {
    const { recorder, warnings } = makeHarness(true);
    const attempt = await recorder.begin(CONTEXT, {});
    await expect(
      attempt.close({
        outcome: 'failed',
        terminationReason: 'pre_spawn_refusal',
        payload: { secretish: 'operator content that must not be re-logged' }
      })
    ).resolves.toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(attempt.attemptId);
    expect(warnings[0]).not.toContain('operator content');
  });

  it('lets the original error reach the caller when the terminal write fails inside a finally', async () => {
    // The seam T020 uses, modelled exactly: an exception raised inside a
    // `finally` REPLACES the one already propagating. If `close()` threw, the
    // caller would see an audit error where a backend refusal should have been.
    const { recorder } = makeHarness(true);
    const attempt = await recorder.begin(CONTEXT, {});
    const refusal = new Error('uncontained backend refused');

    const drive = async (): Promise<never> => {
      try {
        throw refusal;
      } finally {
        await attempt.close({ outcome: 'failed', terminationReason: 'pre_spawn_refusal' });
      }
    };

    await expect(drive()).rejects.toBe(refusal);
  });

  it('holds NEVER THROWS when the diagnostic itself throws', async () => {
    // The logger is a STRUCTURAL parameter — `{ warn(message: string): void }` —
    // and TypeScript has no effect type, so nothing in the signature says the
    // injected `warn` returns rather than throws. The concrete `SanitizedLogger`
    // is total today (`write()` catches every sink failure), but the type admits
    // any object with the method, and the diagnostic runs INSIDE the `catch` —
    // where `close()`'s own try no longer covers it.
    //
    // So this is the failure the test above cannot see: the append fails, the
    // swallow works, and the report of the swallow throws out of the `finally`,
    // replacing the refusal with a logging error. Both halves are asserted —
    // `close()` resolves, and the original error is still what the caller gets.
    let counter = 0;
    const appendRequired = async (
      entry: Omit<AuditEntry, 'id' | 'timestamp'>
    ): Promise<AuditEntry> => {
      if (entry.eventType === 'phase-end') throw new Error('audit writer unavailable');
      return { id: `audit-${++counter}`, timestamp: '2026-09-13T00:00:00Z', ...entry };
    };
    const recorder = new PhaseAttemptRecorder(appendRequired, {
      warn: () => {
        throw new Error('log sink exploded');
      }
    });
    const attempt = await recorder.begin(CONTEXT, {});
    const refusal = new Error('uncontained backend refused');

    await expect(
      attempt.close({ outcome: 'failed', terminationReason: 'pre_spawn_refusal' })
    ).resolves.toBeNull();

    const second = await recorder.begin(CONTEXT, {});
    const drive = async (): Promise<never> => {
      try {
        throw refusal;
      } finally {
        await second.close({ outcome: 'failed', terminationReason: 'pre_spawn_refusal' });
      }
    };
    await expect(drive()).rejects.toBe(refusal);
  });
});

describe('terminalAuditOutcome — the envelope-level verdict (FR-001)', () => {
  it('records a cancellation as info, keeping operator cancels out of the failure population', () => {
    // The standing mapping in `PhaseRunner.runInner` would say `failure` here,
    // because the cancel arm sets `outcome: 'failed'`. The system's own existing
    // statement about a cancel is `info`, on the `cancel` row that same arm appends.
    expect(terminalAuditOutcome('failed', 'cancel')).toBe('info');
    expect(terminalAuditOutcome('clean', 'cancel')).toBe('info');
  });

  it('records a pre-spawn refusal as failure', () => {
    expect(terminalAuditOutcome('failed', 'pre_spawn_refusal')).toBe('failure');
  });

  it('keeps the standing mapping verbatim for every other path', () => {
    expect(terminalAuditOutcome('clean', 'token')).toBe('success');
    expect(terminalAuditOutcome('failed', 'error')).toBe('failure');
    expect(terminalAuditOutcome('timeout', 'timeout')).toBe('info');
  });
});

// Feature 212 / T026 (FR-007, SC-004, SC-007) — counting the envelope-less
// terminations of a Run.
//
// Today that population is visible only as `102 - 99`: the difference between
// two event counts, which is why the 3 envelope-less invocations in the retained
// logs were a subtraction nobody had performed rather than a number anyone could
// read. The requirement is a SINGLE PREDICATE over ONE record type — a
// difference of two counts silently attributes every other discrepancy between
// them (a dropped row, an added event type, a Run still in flight) to this one.
//
// The census below is written as an operator would write it, and the thing under
// test is that it can be written that way at all.
describe('the envelope-less census (FR-007, SC-004, SC-007)', () => {
  type Population = 'received' | 'absent' | 'unknown';

  // ONE predicate, ONE record type. Note what it is NOT:
  // `resultEnvelope !== 'received'` would be one predicate too, and it would
  // count all 99 pre-feature rows as envelope-less — fabricating a nonzero where
  // the truth is "not known", the exact mirror of the false zero this feature
  // removes. An unrecognised value is unknown for the same reason.
  function population(entry: AuditEntry): Population {
    const value = (entry.payload as Record<string, unknown>).resultEnvelope;
    return value === 'received' || value === 'absent' ? value : 'unknown';
  }

  function census(entries: readonly AuditEntry[]): Record<Population, number> {
    const counts: Record<Population, number> = { received: 0, absent: 0, unknown: 0 };
    for (const entry of entries.filter((e) => e.eventType === 'phase-end')) {
      counts[population(entry)] += 1;
    }
    return counts;
  }

  it('reports three populations from one predicate, with pre-feature rows unknown', async () => {
    const { recorder, entries } = makeHarness();

    const withEnvelope = await recorder.begin(CONTEXT, {});
    await withEnvelope.close({
      outcome: 'failed',
      terminationReason: 'error',
      resultEnvelope: 'received'
    });

    const withoutEnvelope = await recorder.begin(CONTEXT, {});
    await withoutEnvelope.close({
      outcome: 'failed',
      terminationReason: 'pre_spawn_refusal',
      resultEnvelope: 'absent'
    });

    // A row as it exists in the retained logs: written before the field did.
    // It is appended through the same writer so the census sees exactly what a
    // reader of `audit.log` sees — no field, and no way to invent one.
    entries.push({
      id: 'audit-historical',
      timestamp: '2026-08-01T00:00:00Z',
      runId: '21d88fae',
      phase: 'speckit-specify',
      iteration: 1,
      eventType: 'phase-end',
      outcome: 'failure',
      payload: { outcome: 'failed', terminationReason: 'error' }
    } as AuditEntry);

    expect(census(entries)).toEqual({ received: 1, absent: 1, unknown: 1 });
  });

  it('does not let the unknown population fall into either claim', async () => {
    // SC-007 stated directly: the historical rows are counted, and they are
    // counted as neither. A census that reported `absent: 1` here would be
    // asserting that a 2026-08 invocation produced no envelope — something no
    // record of it says.
    const { recorder, entries } = makeHarness();
    const attempt = await recorder.begin(CONTEXT, {});
    await attempt.close({ outcome: 'failed', terminationReason: 'error' });

    const counts = census(entries);
    expect(counts.unknown).toBe(1);
    expect(counts.received).toBe(0);
    expect(counts.absent).toBe(0);
  });

  it('needs no second event type to reach the count', async () => {
    // The mechanical form of FR-007: the census reads `phase-end` rows only.
    // If it needed `phase-start` too, every Run still in flight would report a
    // phantom envelope-less phase.
    const { recorder, entries } = makeHarness();
    for (let i = 0; i < 3; i += 1) {
      const attempt = await recorder.begin(CONTEXT, {});
      await attempt.close({
        outcome: 'failed',
        terminationReason: 'timeout',
        resultEnvelope: 'absent'
      });
    }
    // One more attempt left OPEN — a phase still running.
    await recorder.begin(CONTEXT, {});

    expect(census(entries).absent).toBe(3);
    expect(startRecords(entries)).toHaveLength(4);
  });
});
