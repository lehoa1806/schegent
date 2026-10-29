/**
 * FR-R4-F15 (feature 243) — contract Q2: the read request is validated in both directions.
 *
 * `specs/243-retained-failure-diagnostics/contracts/read-request.md` Q6.2. The request side goes
 * through `validateInboundMessage`, the router's one entry, so a path-shaped identifier is refused
 * before any handler or filesystem call. The response side is `isValidReadFailureRecordResponse`, the
 * webview's gate before it renders anything: it runs the same record validator the host reader uses.
 */
import { describe, expect, it } from 'vitest';
import { CMD_READ_FAILURE_RECORD } from '../../../src/contracts/sidebar-ipc';
import type { FailureRecordV1 } from '../../../src/contracts/failure-record';
import {
  isValidReadFailureRecordResponse,
  validateInboundMessage
} from '../../../src/contracts/runtime-validators';

const RECORD: FailureRecordV1 = {
  recordVersion: 1,
  queueId: 'default',
  taskId: 'task-1',
  runId: 'run-1',
  failedAt: '2026-10-28T14:30:05.123Z',
  suffix: '0a1b2c3d',
  cause: 'cap_exhausted',
  issueState: 'listed',
  entries: [{ kind: 'issue', summary: 'one case fails', tag: 'regression', source: 'agent' }],
  omittedIssueCount: 0,
  metrics: [],
  omittedMetricCount: 0
};

const request = (payload: unknown, extra: Record<string, unknown> = {}): unknown => ({
  type: CMD_READ_FAILURE_RECORD,
  correlationId: 'corr-1',
  payload,
  ...extra
});

describe('the request (Q2.1)', () => {
  it('accepts two well-formed identifiers and carries them unchanged', () => {
    const result = validateInboundMessage(request({ queueId: 'default', taskId: 'task-1' }));
    expect(result).toEqual({
      ok: true,
      command: {
        type: CMD_READ_FAILURE_RECORD,
        correlationId: 'corr-1',
        payload: { queueId: 'default', taskId: 'task-1' }
      }
    });
  });

  it('accepts dots, dashes and underscores inside an identifier, and a 128-character one', () => {
    expect(validateInboundMessage(request({ queueId: 'q.1_a-b', taskId: 'a'.repeat(128) })).ok).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['129 characters', 'a'.repeat(129)],
    ['a single dot', '.'],
    ['dot-dot', '..'],
    ['a parent path', '../x'],
    ['a slash', 'a/b'],
    ['a backslash', 'a\\b'],
    ['a drive prefix', 'C:'],
    ['an encoded dot-dot', '%2e%2e'],
    ['a space', 'a b'],
    ['a newline', 'a\nb'],
    ['a NUL', 'a\u0000b'],
    ['a non-ASCII letter', 'caf\u00e9'],
    ['a number', 7],
    ['null', null],
    ['an object', {}],
    ['an array', ['a']]
  ])('refuses a queueId that is %s', (_label, value) => {
    expect(validateInboundMessage(request({ queueId: value, taskId: 'task-1' }))).toMatchObject({
      ok: false,
      reason: 'invalid-queueId'
    });
  });

  it.each([
    ['empty', ''],
    ['129 characters', 'a'.repeat(129)],
    ['dot-dot', '..'],
    ['a slash', 'a/b'],
    ['a drive prefix', 'C:\\x'],
    ['a non-string', 42]
  ])('refuses a taskId that is %s', (_label, value) => {
    expect(validateInboundMessage(request({ queueId: 'default', taskId: value }))).toMatchObject({
      ok: false,
      reason: 'invalid-taskId'
    });
  });

  it.each([
    ['no payload', undefined],
    ['a null payload', null],
    ['a string payload', 'x'],
    ['a numeric payload', 3]
  ])('refuses %s as missing-payload', (_label, payload) => {
    expect(validateInboundMessage(request(payload))).toMatchObject({ ok: false, reason: 'missing-payload' });
  });

  it('refuses an extra payload field rather than ignoring it', () => {
    expect(validateInboundMessage(request({ queueId: 'default', taskId: 'task-1', path: '/etc/passwd' }))).toMatchObject({
      ok: false,
      reason: 'unexpected-payload-fields'
    });
  });

  it('refuses a missing identifier as invalid, not as an accepted undefined', () => {
    expect(validateInboundMessage(request({ taskId: 'task-1' }))).toMatchObject({ ok: false, reason: 'invalid-queueId' });
    expect(validateInboundMessage(request({ queueId: 'default' }))).toMatchObject({ ok: false, reason: 'invalid-taskId' });
  });

  it('names the command and the correlation id on a refusal, so the ack can answer it', () => {
    expect(validateInboundMessage(request({ queueId: '..', taskId: 'task-1' }))).toEqual({
      ok: false,
      reason: 'invalid-queueId',
      type: CMD_READ_FAILURE_RECORD,
      correlationId: 'corr-1'
    });
  });
});

describe('the response (Q2.2)', () => {
  const address = { queueId: 'default', taskId: 'task-1' };

  it('accepts every arm', () => {
    for (const response of [
      { outcome: 'available', ...address, record: RECORD, recordCount: 1 },
      { outcome: 'available', ...address, record: RECORD, recordCount: 3 },
      { outcome: 'none', ...address },
      { outcome: 'expired', ...address },
      { outcome: 'unavailable', ...address },
      { outcome: 'malformed', ...address, recordCount: 2 },
      { outcome: 'failure', reason: 'unknown-row' },
      { outcome: 'failure', reason: 'internal-error' }
    ]) {
      expect(isValidReadFailureRecordResponse(response), JSON.stringify(response)).toBe(true);
    }
  });

  it('refuses an available arm whose record is invalid', () => {
    const response = { outcome: 'available', ...address, record: { ...RECORD, recordVersion: 2 }, recordCount: 1 };
    expect(isValidReadFailureRecordResponse(response)).toBe(false);
  });

  it('refuses an available arm whose record carries a control character in a summary', () => {
    const record = { ...RECORD, entries: [{ ...RECORD.entries[0], summary: 'a\u0007b' }] };
    expect(isValidReadFailureRecordResponse({ outcome: 'available', ...address, record, recordCount: 1 })).toBe(false);
  });

  it('refuses a record whose task id differs from the arm\'s', () => {
    const response = { outcome: 'available', queueId: 'default', taskId: 'task-2', record: RECORD, recordCount: 1 };
    expect(isValidReadFailureRecordResponse(response)).toBe(false);
  });

  it('refuses a record whose queue id differs from the arm\'s', () => {
    const response = { outcome: 'available', queueId: 'other', taskId: 'task-1', record: RECORD, recordCount: 1 };
    expect(isValidReadFailureRecordResponse(response)).toBe(false);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2, '1', null, undefined])(
    'refuses recordCount %j on available and malformed',
    (count) => {
      expect(isValidReadFailureRecordResponse({ outcome: 'available', ...address, record: RECORD, recordCount: count })).toBe(false);
      expect(isValidReadFailureRecordResponse({ outcome: 'malformed', ...address, recordCount: count })).toBe(false);
    }
  );

  it('refuses an unknown outcome, a failure with an unknown reason, and a non-object', () => {
    expect(isValidReadFailureRecordResponse({ outcome: 'maybe', ...address })).toBe(false);
    expect(isValidReadFailureRecordResponse({ outcome: 'failure', reason: 'forbidden' })).toBe(false);
    expect(isValidReadFailureRecordResponse({ outcome: 'failure' })).toBe(false);
    for (const value of [null, undefined, 'none', 7, [], true]) {
      expect(isValidReadFailureRecordResponse(value)).toBe(false);
    }
  });

  it('refuses an arm that is missing its identifiers, or whose identifiers are path-shaped', () => {
    expect(isValidReadFailureRecordResponse({ outcome: 'none' })).toBe(false);
    expect(isValidReadFailureRecordResponse({ outcome: 'none', queueId: '..', taskId: 'task-1' })).toBe(false);
    expect(isValidReadFailureRecordResponse({ outcome: 'expired', queueId: 'default', taskId: 'a/b' })).toBe(false);
  });

  it('refuses a field that is not part of the arm, so a path cannot ride along', () => {
    expect(isValidReadFailureRecordResponse({ outcome: 'none', ...address, path: '/etc/passwd' })).toBe(false);
    expect(
      isValidReadFailureRecordResponse({ outcome: 'available', ...address, record: RECORD, recordCount: 1, path: '/x' })
    ).toBe(false);
  });

  it('does not throw on a getter or a hostile proxy', () => {
    const hostile = { outcome: 'none' } as Record<string, unknown>;
    Object.defineProperty(hostile, 'queueId', {
      enumerable: true,
      get() {
        throw new Error('getter ran');
      }
    });
    expect(() => isValidReadFailureRecordResponse(hostile)).not.toThrow();
    expect(isValidReadFailureRecordResponse(hostile)).toBe(false);
    const proxy = new Proxy({}, { get() { throw new Error('trap'); }, ownKeys() { throw new Error('trap'); } });
    expect(() => isValidReadFailureRecordResponse(proxy)).not.toThrow();
  });
});
