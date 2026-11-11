// FR-R6-F13 T027 — permission request validation and the fail-closed answer (research R4,
// FR-009, FR-011).
import { describe, expect, it } from 'vitest';

import type { AcpPermissionRequest } from '../../../src/contracts/acp-runtime';
import { decidePermission, parsePermissionParams } from '../../../src/services/acp-runtime/permission-policy';

const BOTH: AcpPermissionRequest = {
  sessionId: 's',
  attemptId: 'attempt-1',
  toolCallId: 'call-1',
  toolTitle: 'Write file',
  options: [
    { optionId: 'allow', kind: 'allow_once' },
    { optionId: 'never', kind: 'reject_always' },
    { optionId: 'reject', kind: 'reject_once' }
  ]
};

describe('parsePermissionParams', () => {
  it('reads the session, tool call and options', () => {
    expect(
      parsePermissionParams({
        sessionId: 's',
        toolCall: { toolCallId: 'call-1', title: 'Write file' },
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }]
      })
    ).toEqual({ ok: true, sessionId: 's', toolCallId: 'call-1', toolTitle: 'Write file', options: [{ optionId: 'allow', kind: 'allow_once' }] });
  });

  it('reads an absent tool call as nulls', () => {
    expect(parsePermissionParams({ sessionId: 's', options: [] })).toMatchObject({ ok: true, toolCallId: null, toolTitle: null });
  });

  it('refuses malformed params', () => {
    const tooMany = Array.from({ length: 33 }, (_, n) => ({ optionId: `o${n}`, kind: 'allow_once' }));
    const invalid: unknown[] = [
      null,
      { options: [] },
      { sessionId: '', options: [] },
      { sessionId: 's' },
      { sessionId: 's', options: [{ optionId: 'a', kind: 'maybe' }] },
      { sessionId: 's', options: [{ optionId: 3, kind: 'allow_once' }] },
      { sessionId: 's', options: tooMany }
    ];
    for (const params of invalid) {
      expect(parsePermissionParams(params)).toEqual({ ok: false });
    }
  });

  // Review S-1: an identifier with a hidden character is never handed to the policy.
  it('refuses a session or option id that carries a control or format character, and nulls such a tool call id', () => {
    const escape = String.fromCodePoint(0x1b);
    const override = String.fromCodePoint(0x202e);
    const options = [{ optionId: 'allow', kind: 'allow_once' }];
    expect(parsePermissionParams({ sessionId: `s${escape}`, options })).toEqual({ ok: false });
    expect(parsePermissionParams({ sessionId: 's', options: [{ optionId: `allow${override}`, kind: 'allow_once' }] })).toEqual({ ok: false });
    expect(parsePermissionParams({ sessionId: 's', toolCall: { toolCallId: `call${escape}` }, options })).toMatchObject({
      ok: true,
      toolCallId: null
    });
  });
});

describe('decidePermission', () => {
  it('selects the option the policy chose', () => {
    expect(decidePermission(BOTH, () => ({ optionId: 'allow' }), false)).toEqual({ outcome: 'selected', optionId: 'allow' });
  });

  it('falls back to reject_once when the policy is absent, undecided, unknown or throws', () => {
    const fallback = { outcome: 'selected', optionId: 'reject' };
    expect(decidePermission(BOTH, undefined, false)).toEqual(fallback);
    expect(decidePermission(BOTH, () => 'undecided', false)).toEqual(fallback);
    expect(decidePermission(BOTH, () => ({ optionId: 'not-offered' }), false)).toEqual(fallback);
    const throwing = (): 'undecided' => {
      throw new Error('policy bug');
    };
    expect(decidePermission(BOTH, throwing, false)).toEqual(fallback);
  });

  it('falls back to reject_always, then cancelled', () => {
    const noOnce: AcpPermissionRequest = { ...BOTH, options: BOTH.options.filter((option) => option.kind !== 'reject_once') };
    const allowOnly: AcpPermissionRequest = { ...BOTH, options: [{ optionId: 'allow', kind: 'allow_once' }] };
    expect(decidePermission(noOnce, undefined, false)).toEqual({ outcome: 'selected', optionId: 'never' });
    expect(decidePermission(allowOnly, undefined, false)).toEqual({ outcome: 'cancelled' });
  });

  it('answers cancelled while cancelling, whatever the policy says', () => {
    let asked = 0;
    const policy = (): { optionId: string } => {
      asked += 1;
      return { optionId: 'allow' };
    };
    expect(decidePermission(BOTH, policy, true)).toEqual({ outcome: 'cancelled' });
    expect(asked).toBe(0);
  });
});
