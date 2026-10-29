/**
 * FR-R4-F20 (feature 248) — contract C2 and T6.3: a Skip names the Run the operator confirmed.
 *
 * `specs/248-failed-run-skip-contract/contracts/skip-ipc.md` C2. `CMD_SKIP_PHASE` carries
 * `{ queueId, runId, phaseId }`, and the service refuses a Run id that is not the queue's current
 * Run. A Skip with no valid `runId` is the case that would act on whichever Run the queue holds
 * when the message arrives, so it is refused here, at the one boundary, before any handler runs.
 * The request goes through `validateInboundMessage`, the router's one entry. The Restart case is the
 * control: a sibling whose payload has no `runId` still passes, so the refusals below are Skip's own
 * and not a change to the shared `phaseId` validator.
 */
import { describe, expect, it } from 'vitest';
import { CMD_RESTART_PHASE, CMD_SKIP_PHASE } from '../../../src/contracts/sidebar-ipc';
import { validateInboundMessage } from '../../../src/contracts/runtime-validators';
import { QUEUE_ID_MAX } from '../../../src/contracts/validators/shared';

const CORRELATION_ID = 'corr-1';

const skip = (payload: unknown): unknown => ({
  type: CMD_SKIP_PHASE,
  correlationId: CORRELATION_ID,
  payload
});

const VALID = { queueId: 'default', runId: 'run-1', phaseId: 'implement' };

const refusal = (reason: string): unknown => ({
  ok: false,
  reason,
  type: CMD_SKIP_PHASE,
  correlationId: CORRELATION_ID
});

describe('the Skip payload (contract C2, T6.3)', () => {
  it('accepts a payload of exactly queueId, runId and phaseId, and carries all three unchanged', () => {
    const result = validateInboundMessage(skip(VALID));
    expect(result).toEqual({
      ok: true,
      command: { type: CMD_SKIP_PHASE, correlationId: CORRELATION_ID, payload: VALID }
    });
    if (!result.ok) throw new Error('unreachable: asserted ok above');
    expect(Object.keys((result.command as { payload: object }).payload).sort()).toEqual([
      'phaseId',
      'queueId',
      'runId'
    ]);
  });

  it('accepts a runId of exactly QUEUE_ID_MAX characters', () => {
    const runId = 'r'.repeat(QUEUE_ID_MAX);
    expect(validateInboundMessage(skip({ ...VALID, runId })).ok).toBe(true);
  });

  it('refuses an absent payload as missing-payload', () => {
    expect(validateInboundMessage(skip(undefined))).toEqual(refusal('missing-payload'));
    expect(validateInboundMessage(skip(null))).toEqual(refusal('missing-payload'));
  });

  it('refuses a key outside queueId, runId and phaseId as unexpected-payload-fields', () => {
    expect(validateInboundMessage(skip({ ...VALID, extra: 'x' }))).toEqual(
      refusal('unexpected-payload-fields')
    );
  });

  it('refuses a payload with no runId as invalid-runId (US3-6, FR-007)', () => {
    const { queueId, phaseId } = VALID;
    expect(validateInboundMessage(skip({ queueId, phaseId }))).toEqual(refusal('invalid-runId'));
  });

  it.each([
    ['empty', ''],
    [`${QUEUE_ID_MAX + 1} characters`, 'r'.repeat(QUEUE_ID_MAX + 1)],
    ['a number', 42],
    ['null', null],
    ['an object', { id: 'run-1' }]
  ])('refuses a runId that is %s as invalid-runId', (_label, runId) => {
    expect(validateInboundMessage(skip({ ...VALID, runId }))).toEqual(refusal('invalid-runId'));
  });

  it('keeps the existing queueId and phaseId refusals, in the order contract C2 checks them', () => {
    expect(validateInboundMessage(skip({ ...VALID, queueId: '' }))).toEqual(
      refusal('invalid-queueId')
    );
    expect(validateInboundMessage(skip({ ...VALID, phaseId: '' }))).toEqual(
      refusal('invalid-phaseId')
    );
    // An invalid queueId is reported before an invalid runId, as the breakpoint validator does.
    expect(validateInboundMessage(skip({ queueId: '', runId: '', phaseId: 'p' }))).toEqual(
      refusal('invalid-queueId')
    );
  });

  it('control: a Restart with { queueId, phaseId } and no runId still passes (C5)', () => {
    const payload = { queueId: 'default', phaseId: 'implement' };
    expect(
      validateInboundMessage({ type: CMD_RESTART_PHASE, correlationId: CORRELATION_ID, payload })
    ).toEqual({
      ok: true,
      command: { type: CMD_RESTART_PHASE, correlationId: CORRELATION_ID, payload }
    });
  });
});
