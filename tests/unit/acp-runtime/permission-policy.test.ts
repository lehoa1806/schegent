// FR-R6-F13 T027 — permission request validation and the fail-closed answer (research R4,
// FR-009, FR-011).
import { describe, expect, it } from 'vitest';

import type { AcpPermissionRequest } from '../../../src/contracts/acp-runtime';
import {
  decidePermission,
  decidePermissionMaybeAsync,
  formatPermissionTitleForDisplay,
  parsePermissionParams,
  sanitizePermissionRequest
} from '../../../src/services/acp-runtime/permission-policy';
import { AGENT_DISPLAY_TITLE_MAX_CHARS } from '../../../src/services/acp-runtime/agent-identifier';
import {
  AcpAuthorityGate,
  summarizePermissionDecision,
  type SanitizedPermissionDecisionSummary
} from '../../../src/services/containment-qualification/acp-authority-gate';

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

describe('FR-R7-17 (R7-17-05) — hostile permission toolTitle sanitization across parser, policy, and authority gate', () => {
  const FAKE_SECRET = ['sk', 'proj', 'A'.repeat(28)].join('-');
  const HOSTILE_TITLE =
    `\u001b[31mWrite\u001b[0m \u001b]0;spoof\u0007\u202efake\u202c ` +
    `\u2066iso\u2069\u200e\u200f\u061c\r\nline2\u2028sep\u2029end ${FAKE_SECRET} ` +
    'Z'.repeat(120_000);

  it('sanitizes hostile toolCall.title on receive in parsePermissionParams and formatPermissionTitleForDisplay', () => {
    const parsed = parsePermissionParams({
      sessionId: 's',
      toolCall: { toolCallId: 'call-hostile', title: HOSTILE_TITLE },
      options: [{ optionId: 'reject', kind: 'reject_once' }]
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.toolTitle).not.toBeNull();
    expect(parsed.toolTitle!.length).toBeLessThanOrEqual(AGENT_DISPLAY_TITLE_MAX_CHARS);
    expect(parsed.toolTitle).not.toMatch(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u);
    expect(parsed.toolTitle).not.toContain(FAKE_SECRET);
    expect(parsed.toolTitle).not.toContain('\u001b');
    expect(parsed.toolTitle).toContain('[REDACTED]');
    expect(formatPermissionTitleForDisplay(HOSTILE_TITLE)).toBe(parsed.toolTitle);
    expect(formatPermissionTitleForDisplay('\u001b[31m\u202e\u2066\u200f\r\n')).toBeNull();
  });

  it('sanitizes raw AcpPermissionRequest before policy evaluation and in AcpAuthorityGate summaries', async () => {
    const seenTitles: (string | null)[] = [];
    const hostileRequest: AcpPermissionRequest = {
      ...BOTH,
      toolTitle: HOSTILE_TITLE
    };

    expect(sanitizePermissionRequest(hostileRequest).toolTitle).not.toMatch(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u);

    decidePermission(
      hostileRequest,
      (req) => {
        seenTitles.push(req.toolTitle);
        return 'undecided';
      },
      false
    );
    await decidePermissionMaybeAsync(
      hostileRequest,
      async (req) => {
        seenTitles.push(req.toolTitle);
        return 'undecided' as const;
      },
      false
    );
    expect(seenTitles).toHaveLength(2);
    for (const title of seenTitles) {
      expect(title).not.toBeNull();
      expect(title!.length).toBeLessThanOrEqual(AGENT_DISPLAY_TITLE_MAX_CHARS);
      expect(title).not.toMatch(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u);
      expect(title).not.toContain(FAKE_SECRET);
    }

    const summaries: SanitizedPermissionDecisionSummary[] = [];
    const gate = new AcpAuthorityGate({
      isWorkspaceTrusted: () => true,
      holdsPrimacy: () => true,
      currentOwnershipGeneration: () => 1
    });
    gate.registerScope({
      attemptId: 'attempt-1',
      acpSessionId: 's',
      connectionGeneration: 1,
      ownershipGeneration: 1,
      executionRoot: '/tmp/ws'
    });
    const gatePolicy = gate.createPermissionPolicy(1, {
      allowAuthorizedOnce: false,
      onPermissionDecision: (summary) => summaries.push(summary)
    });
    expect(gatePolicy(hostileRequest)).toBe('undecided');
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.toolTitle).not.toBeNull();
    expect(summaries[0]!.toolTitle!.length).toBeLessThanOrEqual(AGENT_DISPLAY_TITLE_MAX_CHARS);
    expect(summaries[0]!.toolTitle).not.toMatch(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u);
    expect(summaries[0]!.toolTitle).not.toContain(FAKE_SECRET);

    const directSummary = summarizePermissionDecision(hostileRequest, gate.authorize({
      requestKind: 'permission',
      acpSessionId: 's',
      connectionGeneration: 1,
      attemptId: 'attempt-1',
      mutating: true
    }));
    expect(directSummary.toolTitle).toBe(summaries[0]!.toolTitle);
  });
});
