/**
 * FR-R5-F19 (spec 278, T19.1, FR-004) — the open request names a row and nothing else.
 *
 * `specs/278-blocked-work-handoff-recovery/contracts/decision-record-open.md`. A request that carries a
 * path, record text or an operator note is refused at the router's one entry, before any handler runs,
 * so no value from the webview can reach a filesystem call or a backend prompt through this command.
 */
import { describe, expect, it } from 'vitest';
import { CMD_OPEN_DECISION_RECORD } from '../../../src/contracts/sidebar-ipc';
import { validateInboundMessage } from '../../../src/contracts/runtime-validators';

const request = (payload: unknown, extra: Record<string, unknown> = {}): unknown => ({
  type: CMD_OPEN_DECISION_RECORD,
  correlationId: 'corr-1',
  payload,
  ...extra
});

describe('the open-decision-record request', () => {
  it('accepts one well-formed row id and carries it unchanged', () => {
    expect(validateInboundMessage(request({ rowId: 'task-1' }))).toEqual({
      ok: true,
      command: {
        type: CMD_OPEN_DECISION_RECORD,
        correlationId: 'corr-1',
        payload: { rowId: 'task-1' }
      }
    });
  });

  it('accepts a 128-character id with dots, dashes and underscores', () => {
    expect(validateInboundMessage(request({ rowId: `a.b_c-${'x'.repeat(122)}` })).ok).toBe(true);
  });

  it.each([
    ['path', { rowId: 'task-1', path: 'specs/x/decisions.md' }],
    ['content', { rowId: 'task-1', content: '# Decision' }],
    ['note', { rowId: 'task-1', note: 'approve it' }],
    ['featureDir', { rowId: 'task-1', featureDir: 'specs/x' }]
  ])('rejects a request that also carries %s', (_name, payload) => {
    const result = validateInboundMessage(request(payload));
    expect(result.ok).toBe(false);
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['an array', ['task-1']],
    ['a string', 'task-1'],
    ['empty', {}]
  ])('rejects a payload that is %s', (_name, payload) => {
    expect(validateInboundMessage(request(payload)).ok).toBe(false);
  });

  it.each([
    ['empty', ''],
    ['129 characters', 'a'.repeat(129)],
    ['a single dot', '.'],
    ['dot-dot', '..'],
    ['a traversal', '../x'],
    ['a slash', 'a/b'],
    ['a backslash', 'a\\b'],
    ['a drive prefix', 'C:'],
    ['an encoded dot-dot', '%2e%2e'],
    ['a number', 7],
    ['null', null]
  ])('rejects a row id that is %s', (_name, rowId) => {
    expect(validateInboundMessage(request({ rowId })).ok).toBe(false);
  });
});
