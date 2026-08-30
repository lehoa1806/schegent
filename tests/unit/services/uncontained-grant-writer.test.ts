// FR-R3-144 (T010, T013, T014) — the one writer for the uncontained grant list.
//
// FR-R3-146 put the grant write inside the consent modal's module, where it was
// reached exactly once and only ever appended. This item adds a second caller: a
// Settings surface with a control per backend, which can also REVOKE, and which an
// operator can leave open across a whole session. That second caller is what makes
// the read-modify-write hazard real rather than theoretical, so it gets its own
// module and its own suite.
//
// THE HAZARD, NAMED. A tab renders a checkbox per backend from the list it read
// when it opened. Ticking one and saving is naturally written as "send the list
// this tab has, plus the box that changed" — a WHOLE-ARRAY write. Between the read
// and the save, anything else may have written: the consent modal in this window,
// another window's modal, the operator editing `settings.json` by hand. A
// whole-array write built from the stale copy silently deletes whatever arrived in
// between, and what it deletes is a security grant the operator explicitly made.
//
// The first block below therefore has two halves. The first DEMONSTRATES the
// defect against a whole-array writer of the shape a tab would naturally use, so
// the second half is known to be testing something; without it, "the concurrent
// grant survives" would pass against an implementation that never had the race.
import { describe, expect, it, vi } from 'vitest';

import {
  setUncontainedGrant,
  type UncontainedConsentConfig
} from '../../../src/services/uncontained-grant-writer';
import {
  ALLOW_UNCONTAINED_SETTING,
  mechanismOf,
  resolveUncontainedGrant
} from '../../../src/services/backend-containment-policy';
import { CONFIGURATION_TARGET_GLOBAL } from '../../../src/config/general-settings';
import { KEY_SPECS } from '../../../src/config/general-settings-keys';
import { SETTINGS_SCHEMA } from '../../../src/config/settings-schema';
import { SUPPORTED_BACKENDS, type BackendRunnerKind } from '../../../src/contracts/backend-kinds';

/**
 * A settings store one write deep, with a seam for the OTHER writer.
 *
 * `setExternally` is how a concurrent write is expressed: it changes the stored
 * value without going through `update`, which is exactly what another window, or
 * a hand edit of `settings.json`, looks like from here.
 */
function stubConfig(initial: unknown = []) {
  let stored = initial;
  const update = vi.fn(async (_key: string, value: unknown, _target: number) => {
    stored = value;
  });
  const config: UncontainedConsentConfig = {
    get: <T>(): T | undefined => stored as T | undefined,
    update
  };
  const logger = { info: vi.fn(), warn: vi.fn() };
  return {
    config,
    update,
    logger,
    deps: { config, logger },
    read: (): unknown => stored,
    setExternally: (value: unknown): void => {
      stored = value;
    }
  };
}

describe('setUncontainedGrant — the stale draft (FR-006, C-3)', () => {
  it('demonstrates the loss: a whole-array write built from a stale draft', async () => {
    const c = stubConfig([]);

    // The tab reads the list once, when it opens, to render its checkboxes.
    const draft = [...(c.read() as readonly string[])];
    // While the tab is open, the consent modal in another window grants `claude`.
    c.setExternally(['claude']);
    // The operator ticks `agy` and saves. The tab sends what the tab has.
    await c.config.update(ALLOW_UNCONTAINED_SETTING, [...draft, 'agy'], CONFIGURATION_TARGET_GLOBAL);

    expect(
      c.read(),
      'this assertion pins the DEFECT, not the requirement. If it starts failing, the ' +
        'whole-array write above stopped losing the concurrent grant, and the test below ' +
        'stopped proving anything.'
    ).toEqual(['agy']);
    expect(c.read()).not.toContain('claude');
  });

  it('re-reads at write time, so the concurrent grant survives', async () => {
    const c = stubConfig([]);

    const draft = [...(c.read() as readonly string[])];
    c.setExternally(['claude']);

    await expect(setUncontainedGrant(c.deps, 'agy', true)).resolves.toEqual({
      decision: 'granted'
    });

    // Against a whole-array write this reads `expected [ 'agy' ] to contain 'claude'`.
    expect(c.read()).toContain('claude');
    expect(c.read()).toEqual(['claude', 'agy']);
    // Non-vacuity: the draft really was stale — it never held `claude`.
    expect(draft).toEqual([]);
  });

  it('re-reads on revoke too, so the other window grant is not resurrected', async () => {
    // The mirror case, and the one a "write the array I have" fix would get wrong in
    // the other direction: revoking `agy` must not put back a `claude` that was
    // removed after this tab read, nor delete a `claude` that was added.
    const c = stubConfig(['agy']);
    c.setExternally(['agy', 'claude']);

    await expect(setUncontainedGrant(c.deps, 'agy', false)).resolves.toEqual({
      decision: 'denied'
    });
    expect(c.read()).toEqual(['claude']);
  });
});

describe('setUncontainedGrant — membership is the policy modules answer', () => {
  it('grants nothing for codex, in the policy modules own words (T013)', async () => {
    // `codex` carries an OS-enforced bound and was never refused, so naming it in
    // the setting means nothing. `resolveUncontainedGrant` already has a sentence
    // for that, and this must be that sentence rather than a second one written
    // here — two sentences for one fact drift, and the operator gets whichever
    // surface they happened to look at.
    // `.at(0)` rather than `[0]`, following `src`'s own idiom: the head of an
    // array is TYPED as present while it may well be absent, and this project's
    // two ratchets take opposite sides of that. `no-unnecessary-condition` reads
    // the `?.` below as dead syntax when the head types as present; the
    // `noUncheckedIndexedAccess` ratchet counts the unguarded read as a new site
    // when it does not. `.at()` is typed `| undefined` under both, so one shape
    // satisfies both, and the chain says something true.
    const expected = resolveUncontainedGrant(['codex']).problems.at(0);
    expect(expected?.problem, 'the policy module must classify codex as already-contained').toBe(
      'already-contained'
    );

    const c = stubConfig([]);
    await expect(setUncontainedGrant(c.deps, 'codex', true)).resolves.toEqual({
      decision: 'not-applicable',
      problem: 'already-contained',
      message: expected?.message
    });
    expect(c.update).not.toHaveBeenCalled();
    // Non-vacuity: the message is the substantive one, not an empty string that
    // would make the identity assertion above pass against anything.
    expect(expected?.message).toContain(mechanismOf('codex'));
    expect(expected?.message).toContain(ALLOW_UNCONTAINED_SETTING);
  });

  it('reports the same no-op when codex is revoked', async () => {
    // Both directions, because the grant list never governed `codex` either way.
    const c = stubConfig(['codex']);
    const outcome = await setUncontainedGrant(c.deps, 'codex', false);
    expect(outcome.decision).toBe('not-applicable');
    expect(c.update).not.toHaveBeenCalled();
    expect(c.read()).toEqual(['codex']);
  });

  it('refuses an id outside SUPPORTED_BACKENDS and writes nothing (T014)', async () => {
    // The cast is the point: the IPC validator rejects this before it arrives, and
    // the type says it cannot. This asserts what happens if both are wrong, because
    // the failure mode is a settings write, at application scope, of an id nothing
    // in the product recognises.
    const typo = 'claud' as BackendRunnerKind;
    const expected = resolveUncontainedGrant([typo]).problems.at(0);

    const c = stubConfig([]);
    await expect(setUncontainedGrant(c.deps, typo, true)).resolves.toEqual({
      decision: 'not-applicable',
      problem: 'unsupported',
      message: expected?.message
    });
    expect(c.update).not.toHaveBeenCalled();
    expect(expected?.message).toContain(SUPPORTED_BACKENDS.join(', '));
  });

  it('accepts every uncontained member of SUPPORTED_BACKENDS, enumerated', async () => {
    // Enumerated rather than sampled: a fourth backend added to the union must be
    // decided by this writer too, and "we tested claude and agy" is how the fourth
    // one arrives undecided.
    for (const kind of SUPPORTED_BACKENDS) {
      const c = stubConfig([]);
      const outcome = await setUncontainedGrant(c.deps, kind, true);
      const contained = resolveUncontainedGrant([kind]).problems.length > 0;
      expect(outcome.decision, `${kind}`).toBe(contained ? 'not-applicable' : 'granted');
    }
  });
});

describe('setUncontainedGrant — what it writes', () => {
  it('writes the one key at application scope', async () => {
    const c = stubConfig([]);
    await setUncontainedGrant(c.deps, 'claude', true);
    expect(c.update).toHaveBeenCalledWith(
      ALLOW_UNCONTAINED_SETTING,
      ['claude'],
      CONFIGURATION_TARGET_GLOBAL
    );
  });

  it('appends exactly one id, leaving the rest of the list alone', async () => {
    const c = stubConfig(['codex', 'claud']);
    await setUncontainedGrant(c.deps, 'claude', true);
    expect(c.read()).toEqual(['codex', 'claud', 'claude']);
  });

  it('writes nothing when the id is already granted', async () => {
    const c = stubConfig(['claude']);
    await expect(setUncontainedGrant(c.deps, 'claude', true)).resolves.toEqual({
      decision: 'granted'
    });
    expect(c.update).not.toHaveBeenCalled();
  });

  it('writes nothing when a revoked id was not granted', async () => {
    const c = stubConfig(['agy']);
    await expect(setUncontainedGrant(c.deps, 'claude', false)).resolves.toEqual({
      decision: 'denied'
    });
    expect(c.update).not.toHaveBeenCalled();
  });

  it('removes every occurrence on revoke, so a duplicated entry does not survive', async () => {
    // A hand-edited `settings.json` can hold the same id twice. Removing the first
    // one and reporting success would leave the grant in force.
    const c = stubConfig(['claude', 'agy', 'claude']);
    await setUncontainedGrant(c.deps, 'claude', false);
    expect(c.read()).toEqual(['agy']);
  });

  it('keeps an unsupported entry rather than deleting the operator typo', async () => {
    // `resolveUncontainedGrant` reports it. Silently removing it is how an operator
    // never finds out they misspelled a backend id.
    const c = stubConfig(['claud', 42]);
    await setUncontainedGrant(c.deps, 'claude', true);
    expect(c.read()).toEqual(['claud', 'claude']);
  });

  it('replaces a malformed value, which grants nothing today, without inventing entries', async () => {
    const c = stubConfig(true);
    await setUncontainedGrant(c.deps, 'claude', true);
    expect(c.read()).toEqual(['claude']);
  });

  it('does not repair a malformed value on a revoke that has nothing to remove', async () => {
    // Writing `[]` over it would silently fix a setting the operator should be told
    // about, and a revoke is not the place to find out.
    const c = stubConfig(true);
    await expect(setUncontainedGrant(c.deps, 'claude', false)).resolves.toEqual({
      decision: 'denied'
    });
    expect(c.update).not.toHaveBeenCalled();
    expect(c.read()).toBe(true);
  });

  it('reports a rejected write as its own fault, not as a refusal', async () => {
    const c = stubConfig([]);
    c.update.mockRejectedValueOnce(new Error('profile is read-only'));
    await expect(setUncontainedGrant(c.deps, 'claude', true)).resolves.toEqual({
      decision: 'write-failed',
      reason: 'profile is read-only'
    });
  });

  it('reports a rejected REVOKE the same way, so a failed revoke is not read as done', async () => {
    // The direction that matters more: reporting a failed revoke as success leaves
    // the operator believing a grant is gone while it is still in force.
    const c = stubConfig(['claude']);
    c.update.mockRejectedValueOnce(new Error('profile is read-only'));
    const outcome = await setUncontainedGrant(c.deps, 'claude', false);
    expect(outcome).toEqual({ decision: 'write-failed', reason: 'profile is read-only' });
    expect(c.read()).toEqual(['claude']);
  });

  it('reports a non-Error rejection without putting undefined in front of an operator', async () => {
    const c = stubConfig([]);
    c.update.mockRejectedValueOnce('EACCES');
    await expect(setUncontainedGrant(c.deps, 'claude', true)).resolves.toEqual({
      decision: 'write-failed',
      reason: 'EACCES'
    });
  });
});

// FR-R3-144 (T019, FR-004) — reading a malformed entry and writing one are not
// the same question, and they must not converge on one answer.
//
// FR-R3-125 established the read half: a `settings.json` holding `"claud"` must
// not stop the extension. The operator typed it by hand, possibly months ago,
// and refusing to activate would take away the very surface they would fix it
// from. So the entry is TOLERATED — the extension starts, the typo grants
// nothing, and the problem is reported.
//
// The write half is the opposite, and for the same reason. Nothing has to
// tolerate `"claud"` arriving over IPC: no operator is locked out by refusing it,
// there is no existing state to preserve, and the far side is a write to an
// application-scoped security setting. Refusing is free here and costly there.
//
// Both halves are asserted in ONE test on purpose. Written as two, a later change
// that "unified" the paths — routing the read through the writer's refusal, or
// relaxing the writer to the reader's tolerance — would leave one of them passing
// and could be read as a partial success. Here it simply fails.
describe('FR-R3-144 T019 — tolerated on the way in, refused on the way out (FR-004)', () => {
  it('reports a malformed stored entry while refusing the same id as a write', () => {
    const typo = 'claud';

    // Read half: the stored list activates and is reportable.
    const resolved = resolveUncontainedGrant([typo, 'claude']);
    expect(resolved.problems).toHaveLength(1);
    expect(resolved.problems[0]?.entry).toBe(typo);
    expect(resolved.problems[0]?.problem).toBe('unsupported');
    // And it grants nothing — the typo is not silently read as the backend it
    // resembles, which is the whole hazard of a near-miss id.
    expect(resolved.granted).not.toContain(typo);
    expect(resolved.granted).toContain('claude');

    // Write half: the same id, arriving as an intent, is refused and touches
    // nothing. `as BackendRunnerKind` is the cast an unvalidated caller would
    // make; the boundary validator refuses it first, and this is what happens if
    // one ever does not.
    const c = stubConfig([typo, 'claude']);
    return setUncontainedGrant(c.deps, typo as BackendRunnerKind, true).then((outcome) => {
      expect(outcome).toEqual({
        decision: 'not-applicable',
        problem: 'unsupported',
        message: resolved.problems[0]?.message
      });
      expect(c.update).not.toHaveBeenCalled();
      // Unchanged, typo included. A writer that "cleaned" the list here would
      // delete the evidence the read half exists to report.
      expect(c.read()).toEqual([typo, 'claude']);
    });
  });
});

describe('FR-R3-144 T039 — the grant list is not a general setting (C7-1, FR-003)', () => {
  it('has no KEY_SPECS entry, and must not be given one', () => {
    const key = ALLOW_UNCONTAINED_SETTING.replace(/^schegent\./, '');
    expect(
      Object.keys(KEY_SPECS),
      // The reason lives in the failure message because the failure is what a
      // future reader will see, and from the outside the omission looks like an
      // oversight: every other `schegent.*` key the tab touches has an entry, and
      // `tests/integration/settings-surface.integration.test.ts` carries a
      // standing EXEMPTIONS row for this one. Adding the entry would make both
      // complaints go away and would be wrong.
      //
      // `KEY_SPECS` is the allowlist for `writeGeneralSettings` — a generic,
      // BATCHED key/value writer. An entry here would put a security grant into
      // the same transaction as `logging.verbose`: one rejected unrelated field
      // takes the grant down with it, and Save All would write the grant with no
      // confirmation at all, because that path has none. The grant has its own
      // writer, `setUncontainedGrant`, for the reasons in its header — a per-id
      // read-modify-write that re-reads at write time, so a settings tab left open
      // for an hour cannot post a stale list that silently revokes another
      // window's grant.
      //
      // If a control for this list is wanted in Settings, it routes through that
      // writer's own IPC command (it already does — see `uncontained-grant.ts`);
      // it does not become a draft field.
      `'${key}' must NOT be a general-settings key: it is a security grant with a ` +
        'dedicated writer (setUncontainedGrant), not a value in the batched ' +
        'draft-save. Route the control through the grant command instead.'
    ).not.toContain(key);
  });

  it('the key it is kept out of is the one the policy module names', () => {
    // Guards the test above against being satisfied by a typo: if the setting were
    // renamed and this file kept checking the old string, the assertion would pass
    // while a real entry sat in `KEY_SPECS` under the new name.
    expect(ALLOW_UNCONTAINED_SETTING).toMatch(/^schegent\./);
    expect(SETTINGS_SCHEMA[ALLOW_UNCONTAINED_SETTING]).toBeDefined();
    // And that `KEY_SPECS` is keyed in the stripped form the assertion above
    // searches for. If it were keyed with the `schegent.` prefix, that assertion
    // would pass for every key in existence and prove nothing. A sibling under
    // the same `backend.` namespace is the cheapest witness.
    expect(Object.keys(KEY_SPECS)).toContain('backend.probeTimeoutSeconds');
  });
});
