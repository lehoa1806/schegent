// FR-R3-144 (T016, D-2, FR-003) — the boundary check for
// `CMD_SET_UNCONTAINED_BACKEND_GRANT`.
//
// Every case here goes through `validateInboundMessage` rather than calling
// `validateSetUncontainedBackendGrant` directly. The validator being correct in
// isolation is not the property that matters: a validator module that no `switch`
// case reaches admits everything, and the command would fall to the `default` arm
// and be refused as unknown — or, worse in a later refactor, be admitted by a
// looser sibling. Routing through the entry point proves the wiring and the rule
// at once.
//
// Each rejection asserts its OWN failure code, not merely `ok === false`. The
// codes are what the router logs and what an operator reads when a grant does not
// land, and "it was refused" is not actionable — "the id was not a backend" and
// "the direction was not a boolean" send someone to two different places.
//
// WHAT THIS FILE DELIBERATELY DOES NOT ASSERT
//
// That `codex` is refused. It is a well-formed payload at this layer and is
// answered `not-applicable` by `setUncontainedGrant`, because containment is a
// policy question and `services/backend-containment-policy.ts` owns it. A test
// here pinning `codex` as invalid would install a second authority for that
// question at the boundary, and the two would part company the first time a
// backend's containment mechanism changed. The third test below pins the
// opposite — that the boundary lets it through — so a later "hardening" that
// moves the policy here fails.

import { describe, expect, it } from 'vitest';
import { validateInboundMessage } from '../../../src/contracts/runtime-validators';
import {
  CMD_SET_UNCONTAINED_BACKEND_GRANT,
  isCmdSetUncontainedBackendGrant
} from '../../../src/contracts/sidebar-ipc';
import { SUPPORTED_BACKENDS } from '../../../src/contracts/backend-kinds';

function envelope(payload: unknown): Record<string, unknown> {
  return { type: CMD_SET_UNCONTAINED_BACKEND_GRANT, correlationId: 'c-1', payload };
}

/** The failure code, or a marker that makes an unexpected accept obvious. */
function reasonOf(raw: unknown): string {
  const result = validateInboundMessage(raw);
  return result.ok ? '<accepted>' : result.reason;
}

describe('FR-R3-144 T016 — validateSetUncontainedBackendGrant accepts', () => {
  it('accepts a grant and narrows the payload to the two declared fields', () => {
    const result = validateInboundMessage(envelope({ kind: 'claude', granted: true }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.command).toEqual({
      type: CMD_SET_UNCONTAINED_BACKEND_GRANT,
      correlationId: 'c-1',
      payload: { kind: 'claude', granted: true }
    });
  });

  it('accepts a revoke — `granted: false` is a direction, not an absent field', () => {
    // The two directions travel on one command. A validator that treated `false`
    // as missing would make revoke unreachable while grant kept working, which is
    // the asymmetry that widens a posture.
    const result = validateInboundMessage(envelope({ kind: 'agy', granted: false }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Narrowed with the type guard rather than a cast: the validator and the
    // guard are two descriptions of one payload, and a command the validator
    // admits that the guard then rejects is a defect neither file would show on
    // its own.
    expect(isCmdSetUncontainedBackendGrant(result.command)).toBe(true);
    if (!isCmdSetUncontainedBackendGrant(result.command)) return;
    expect(result.command.payload).toEqual({ kind: 'agy', granted: false });
  });

  it('admits every supported backend, including the contained one', () => {
    // Enumerated from `SUPPORTED_BACKENDS` rather than listed by hand: a backend
    // added to the platform is admitted here on the day it is added, and the
    // containment answer for it is given once, by the policy module.
    for (const kind of SUPPORTED_BACKENDS) {
      expect(reasonOf(envelope({ kind, granted: true }))).toBe('<accepted>');
    }
    // Named explicitly so the intent survives a future edit to the loop above:
    // `codex` is SHAPE-valid and POLICY-refused, and those are different layers.
    expect(reasonOf(envelope({ kind: 'codex', granted: true }))).toBe('<accepted>');
  });
});

describe('FR-R3-144 T016 — and rejects, each with its own code', () => {
  it('rejects a missing payload as `missing-payload`', () => {
    expect(
      reasonOf({ type: CMD_SET_UNCONTAINED_BACKEND_GRANT, correlationId: 'c-1' })
    ).toBe('missing-payload');
  });

  it('rejects a non-object payload as `missing-payload`', () => {
    expect(reasonOf(envelope(null))).toBe('missing-payload');
    expect(reasonOf(envelope('claude'))).toBe('missing-payload');
    // An array is an object to `typeof`, and `['claude']` is close enough to the
    // stored setting's own shape that a caller could send it by mistake.
    expect(reasonOf(envelope(['claude']))).toBe('missing-payload');
  });

  it('rejects an undeclared field as `unexpected-payload-fields`', () => {
    expect(
      reasonOf(envelope({ kind: 'claude', granted: true, scope: 'workspace' }))
    ).toBe('unexpected-payload-fields');
  });

  it('rejects an id that is not a backend as `invalid-backend-kind`', () => {
    // `'claud'` is the typo FR-004 keeps tolerable in a hand-edited settings file:
    // read back out, it is REPORTED as a problem and grants nothing. Arriving over
    // IPC it is refused outright, because the far side of this command is a write.
    expect(reasonOf(envelope({ kind: 'claud', granted: true }))).toBe('invalid-backend-kind');
    expect(reasonOf(envelope({ kind: '', granted: true }))).toBe('invalid-backend-kind');
    expect(reasonOf(envelope({ granted: true }))).toBe('invalid-backend-kind');
  });

  it('rejects a non-boolean direction as `invalid-granted`', () => {
    // The string `'true'` is truthy, so a validator that only checked presence
    // would parse a malformed revoke as a grant. That is the one failure in this
    // file that widens a posture rather than narrowing it.
    expect(reasonOf(envelope({ kind: 'claude', granted: 'true' }))).toBe('invalid-granted');
    expect(reasonOf(envelope({ kind: 'claude', granted: 'false' }))).toBe('invalid-granted');
    expect(reasonOf(envelope({ kind: 'claude', granted: 1 }))).toBe('invalid-granted');
    expect(reasonOf(envelope({ kind: 'claude' }))).toBe('invalid-granted');
  });

  it('checks the id before the direction, so a bad id is never reported as a bad boolean', () => {
    // Both fields are wrong. The code names the one an operator can act on: a
    // backend id that does not exist is a different bug from a mistyped flag.
    expect(reasonOf(envelope({ kind: 'claud', granted: 'yes' }))).toBe('invalid-backend-kind');
  });
});
