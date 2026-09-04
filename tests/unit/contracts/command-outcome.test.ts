// FR-R3-154 (T1644) — the pure half of mutation-ACK truth.
//
// `normalizeCommandResult` is the one place that decides what a value coming
// back out of `executeCommand` means, and every false `accepted` this batch
// closes passes through it. It is a pure function precisely so the decision can
// be tested against each shape a registered command can actually produce,
// including the two that produce no value at all:
//
//   - a `CommandOutcome`, from the five commands T1645 converts;
//   - a `MutationResult` (`{ ok, reason? }`), the shape the rest of the host's
//     mutating commands return and the shape T1645's commands are built from;
//   - `undefined`, which for a mutating id means the Workspace Trust gate in
//     `src/activation/guarded-command-registration.ts` declined the invocation
//     and returned without running the handler (see its own tests in
//     `tests/unit/activation/guarded-command-registration.test.ts`);
//   - anything else, which means the wiring is wrong.
//
// The last two are the cases that matter most, because both used to be
// indistinguishable from success: a handler that ACKed `accepted` after `await
// exec(...)` reported a committed mutation for a command that had been refused
// before it started.

import { describe, it, expect } from 'vitest';
import {
  ACCEPTED,
  COMMAND_ACK_OUTCOMES,
  ackFieldsFor,
  failed,
  fromMutationResult,
  isCommandOutcome,
  noOp,
  normalizeCommandResult,
  refused,
  type CommandOutcome
} from '../../../src/contracts/command-outcome';

describe('FR-R3-154 (T1644) — the ACK outcome vocabulary', () => {
  it('is exactly the four the acceptance boundary names', () => {
    expect([...COMMAND_ACK_OUTCOMES]).toEqual(['accepted', 'no-op', 'refused', 'failed']);
  });

  it('maps every non-accepted outcome to a rejected status', () => {
    // The binary `status` predates this vocabulary and the webview still reads
    // it. `accepted` has to keep meaning "the host committed the mutation", so
    // a no-op — which commits nothing — is a rejection at the `status` level
    // even though it is not a refusal.
    expect(ackFieldsFor(ACCEPTED)).toEqual({ status: 'accepted', outcome: 'accepted' });
    expect(ackFieldsFor(noOp('nothing-to-do'))).toEqual({
      status: 'rejected',
      outcome: 'no-op',
      reason: 'nothing-to-do'
    });
    expect(ackFieldsFor(refused('no-active-run'))).toEqual({
      status: 'rejected',
      outcome: 'refused',
      reason: 'no-active-run'
    });
    expect(ackFieldsFor(failed('phase-control-failed'))).toEqual({
      status: 'rejected',
      outcome: 'failed',
      reason: 'phase-control-failed'
    });
  });

  it('never emits a reason on the accepted branch', () => {
    // `reason` is why the mutation did not happen. An accepted ACK carrying one
    // reads, to the webview's own ack plumbing, as a rejection with a
    // contradictory status.
    expect('reason' in ackFieldsFor(ACCEPTED)).toBe(false);
  });
});

describe('FR-R3-154 (T1644) — fromMutationResult', () => {
  it('accepts a committed mutation', () => {
    expect(fromMutationResult({ ok: true })).toEqual({ outcome: 'accepted' });
  });

  it('carries a structured refusal reason through verbatim', () => {
    // The reason vocabularies belong to FR-R3-151 (`resolveControlTarget`,
    // `PhaseControlService`) and FR-R3-150/152 (Queue starts). This conversion
    // must not translate, shorten, or default them away — a second eligibility
    // oracle in IPC is what FR-R3-154 section 4 forbids.
    expect(fromMutationResult({ ok: false, reason: 'ambiguous-run-target' })).toEqual({
      outcome: 'refused',
      reason: 'ambiguous-run-target'
    });
  });

  it('names an unexplained refusal rather than dropping it', () => {
    expect(fromMutationResult({ ok: false })).toEqual({
      outcome: 'refused',
      reason: 'operation-rejected'
    });
  });
});

describe('FR-R3-154 (T1644) — normalizeCommandResult', () => {
  it('passes a CommandOutcome through unchanged', () => {
    const outcomes: readonly CommandOutcome[] = [
      ACCEPTED,
      noOp('start-intent-no-change'),
      refused('not-pending-retry'),
      failed('start-queue-failed')
    ];
    for (const outcome of outcomes) {
      expect(normalizeCommandResult(outcome)).toEqual(outcome);
    }
  });

  it('converts a MutationResult, so a command that returns one is not a failure', () => {
    expect(normalizeCommandResult({ ok: true })).toEqual({ outcome: 'accepted' });
    expect(normalizeCommandResult({ ok: false, reason: 'no-active-run' })).toEqual({
      outcome: 'refused',
      reason: 'no-active-run'
    });
  });

  it('reads `undefined` as the Workspace Trust refusal it is', () => {
    // `registerGuardedCommand` warns the operator and returns `undefined`
    // WITHOUT running the handler when the workspace is untrusted. Nothing was
    // committed, so this is the one shape whose old reading — `accepted`,
    // because `await exec(...)` resolved — was false in the most direct way
    // available: the mutation had not merely failed, it had never been
    // attempted.
    expect(normalizeCommandResult(undefined)).toEqual({
      outcome: 'refused',
      reason: 'workspace-not-trusted'
    });
    expect(normalizeCommandResult(null)).toEqual({
      outcome: 'refused',
      reason: 'workspace-not-trusted'
    });
  });

  it('fails closed on a shape it does not recognize', () => {
    // Fail-closed and not fail-open: an unrecognized result is a wiring defect,
    // and reporting a defect as `accepted` is the class of bug this task exists
    // to remove. The operator sees a failure for something that may well have
    // committed, which is wrong but recoverable; the reverse is not.
    for (const value of [42, 'accepted', {}, { outcome: 'maybe' }, { ok: 'yes' }, []]) {
      expect(normalizeCommandResult(value)).toEqual({
        outcome: 'failed',
        reason: 'command-result-unrecognized'
      });
    }
  });

  it('does not treat a bare `outcome` string field as an outcome', () => {
    // `applyStartQueueIntent` returns `{ outcome: 'applied' | 'noop' | ... }`,
    // whose `outcome` values are a DIFFERENT vocabulary that happens to share
    // the field name. `src/commands/start-queue.ts` translates it; if that
    // translation is ever removed, the raw service result must not slip through
    // this function as though it were already an ACK outcome.
    expect(isCommandOutcome({ outcome: 'applied', lifecycleAfter: 'running' })).toBe(false);
    expect(normalizeCommandResult({ outcome: 'applied' })).toEqual({
      outcome: 'failed',
      reason: 'command-result-unrecognized'
    });
    expect(normalizeCommandResult({ outcome: 'noop' })).toEqual({
      outcome: 'failed',
      reason: 'command-result-unrecognized'
    });
  });

  it('requires a reason on every non-accepted outcome', () => {
    // A `{ outcome: 'refused' }` with no reason would ACK a rejection the
    // webview cannot explain, so it is not a valid outcome value.
    expect(isCommandOutcome({ outcome: 'refused' })).toBe(false);
    expect(isCommandOutcome({ outcome: 'accepted' })).toBe(true);
    expect(isCommandOutcome({ outcome: 'refused', reason: 'no-active-run' })).toBe(true);
  });
});
