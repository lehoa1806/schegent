// FR-R3-146 (FR-012, FR-013, SC-005) — the surface that makes a stored Git grant
// observable and revocable.
//
// WHAT THIS GATE IS FOR. FR-012 has been "met" since the feature shipped by five
// documents telling operators to open `.schegent/state.json` and delete an entry.
// No such file exists. The requirement was not partly satisfied and it was not
// under-tested — it was satisfied by a fiction, and no test could have caught that
// because every test that touched withdrawal performed the withdrawal itself.
//
// So the assertions below are about the two things a fiction cannot do: RENDER the
// grant with enough in it to judge, and WITHDRAW exactly what was picked. The
// destructive half is behind a confirmation, and dismissal at either step has to
// leave every grant alone — the list is also the READ half of FR-012, and an
// operator opening it to see what they granted must be able to click a row.

import { describe, expect, it } from 'vitest';

import {
  buildGitApprovalItems,
  runGitApprovals,
  FORGET_ALL_LABEL,
  FORGET_ONE_LABEL,
  NO_APPROVALS_MESSAGE,
  type GitApprovalItem,
  type GitApprovalRecord,
  type GitApprovalsDeps
} from '../../../src/commands/git-approvals';

const FINGERPRINT_A = 'a'.repeat(64);
const FINGERPRINT_B = 'b'.repeat(64);

const record = (
  fingerprint: string,
  overrides: Partial<GitApprovalRecord> = {}
): GitApprovalRecord => ({
  fingerprint,
  grantedAt: 1_700_000_000_000,
  pipelineId: 'spec-driven',
  phaseIds: ['speckit-implement', 'speckit-git-commit'],
  ...overrides
});

const mapOf = (...records: GitApprovalRecord[]): Record<string, GitApprovalRecord> =>
  Object.fromEntries(records.map((entry) => [entry.fingerprint, entry]));

/**
 * The single row a one-grant map produces.
 *
 * The length is asserted rather than assumed, so a builder that returned nothing
 * fails here instead of turning every `expect` below into a check on `undefined`.
 */
function onlyRow(grants: Record<string, GitApprovalRecord>): GitApprovalItem {
  const items = buildGitApprovalItems(grants);
  expect(items).toHaveLength(1);
  return items[0] as GitApprovalItem;
}

interface Harness {
  readonly deps: GitApprovalsDeps;
  readonly forgotten: string[];
  readonly forgetAllCalls: number[];
  readonly messages: string[];
  readonly confirmations: { message: string; detail: string; approveLabel: string }[];
  readonly offered: readonly GitApprovalItem[][];
  remaining: Record<string, GitApprovalRecord>;
}

/**
 * A harness whose `forget` really removes from the map `grants` reads, so a test
 * that asserts "nothing else changed" is reading state and not a call log.
 */
function harness(options: {
  grants: Record<string, GitApprovalRecord>;
  /** Which row the operator picks, by index into what they were offered. */
  pick?: (items: readonly GitApprovalItem[]) => GitApprovalItem | undefined;
  /** What they press on the confirmation. `undefined` is dismissal. */
  confirm?: (approveLabel: string) => string | undefined;
}): Harness {
  const state: Harness = {
    forgotten: [],
    forgetAllCalls: [],
    messages: [],
    confirmations: [],
    offered: [],
    remaining: { ...options.grants },
    deps: undefined as unknown as GitApprovalsDeps
  };

  const offered = state.offered as GitApprovalItem[][];

  (state as { deps: GitApprovalsDeps }).deps = {
    grants: () => state.remaining,
    forget: (fingerprint) => {
      state.forgotten.push(fingerprint);
      if (!Object.prototype.hasOwnProperty.call(state.remaining, fingerprint)) {
        return Promise.resolve(false);
      }
      const next = { ...state.remaining };
      delete next[fingerprint];
      state.remaining = next;
      return Promise.resolve(true);
    },
    forgetAll: () => {
      const count = Object.keys(state.remaining).length;
      state.forgetAllCalls.push(count);
      state.remaining = {};
      return Promise.resolve(count);
    },
    pick: (items) => {
      offered.push([...items]);
      return Promise.resolve(options.pick ? options.pick(items) : items[0]);
    },
    confirm: (message, detail, approveLabel) => {
      state.confirmations.push({ message, detail, approveLabel });
      return Promise.resolve(
        options.confirm ? options.confirm(approveLabel) : approveLabel
      );
    },
    info: (message) => {
      state.messages.push(message);
    }
  };

  return state;
}

describe('git approvals — what the list has to show (FR-R3-146, SC-005)', () => {
  it('names the pipeline, the covered phases and the plan in every row', () => {
    const row = onlyRow(mapOf(record(FINGERPRINT_A)));

    // SC-005 is "judged without reading source code", so the three things the
    // record carries for that purpose have to reach the row. A bare fingerprint
    // is a grant nobody can audit; `git-plan-grants.ts` stores `pipelineId` and
    // `phaseIds` precisely so this row can exist.
    expect(row.label).toBe('spec-driven');
    expect(row.detail).toContain('speckit-implement');
    expect(row.detail).toContain('speckit-git-commit');
    expect(row.detail).toContain(FINGERPRINT_A);
    expect(row.description).toContain('granted');
    expect(row.fingerprint).toBe(FINGERPRINT_A);
  });

  it('distinguishes two grants for the same pipeline, which is the FR-008 case', () => {
    // Editing a pipeline changes the fingerprint and asks again, so a workspace
    // ends up holding two grants whose `pipelineId` is identical. If the row did
    // not carry the fingerprint, the operator would be choosing at random which
    // of two indistinguishable lines to withdraw.
    const items = buildGitApprovalItems(
      mapOf(record(FINGERPRINT_A), record(FINGERPRINT_B))
    );
    const details = items.filter((item) => item.fingerprint !== null).map((item) => item.detail);

    expect(new Set(details).size).toBe(2);
  });

  it('orders newest first', () => {
    const items = buildGitApprovalItems(
      mapOf(
        record(FINGERPRINT_A, { grantedAt: 1_700_000_000_000 }),
        record(FINGERPRINT_B, { grantedAt: 1_700_000_999_000 })
      )
    );

    expect(items[0]?.fingerprint).toBe(FINGERPRINT_B);
    expect(items[1]?.fingerprint).toBe(FINGERPRINT_A);
  });

  it('says so rather than rendering an empty phase list', () => {
    // A grant whose pipeline declared no git-capable phase should not render as
    // "Git-capable phases: " with nothing after the colon, which reads as a
    // truncated row rather than as a fact about the grant.
    const row = onlyRow(mapOf(record(FINGERPRINT_A, { phaseIds: [] })));

    expect(row.detail).toContain('none recorded');
  });

  it('offers no forget-all row for a single grant, and one for two', () => {
    // With one grant, "forget all" and "forget this" are the same act under two
    // names, and a destructive row nobody needs is a mis-click waiting to happen.
    const one = buildGitApprovalItems(mapOf(record(FINGERPRINT_A)));
    expect(one).toHaveLength(1);
    expect(one.every((item) => item.fingerprint !== null)).toBe(true);

    const two = buildGitApprovalItems(mapOf(record(FINGERPRINT_A), record(FINGERPRINT_B)));
    expect(two).toHaveLength(3);
    expect(two.at(-1)?.fingerprint).toBeNull();
    expect(two.at(-1)?.label).toBe(FORGET_ALL_LABEL);
  });

  it('marks the forget-all row with a sentinel no stored key can collide with', () => {
    // `null`, not a reserved string. A fingerprint is attacker-influenced only in
    // the sense that a pipeline definition feeds it, but a magic string would
    // still be a value the map could one day contain.
    const items = buildGitApprovalItems(mapOf(record(FINGERPRINT_A), record(FINGERPRINT_B)));
    const sentinels = items.filter((item) => item.fingerprint === null);

    expect(sentinels).toHaveLength(1);
  });

  it('survives an unreadable grantedAt without losing the row', () => {
    // The reader drops entries whose `grantedAt` is not finite, so this should be
    // unreachable through the store. The row still has to render, because the
    // alternative is an operator who cannot withdraw a grant they can see.
    const row = onlyRow(mapOf(record(FINGERPRINT_A, { grantedAt: Number.NaN })));

    expect(row.fingerprint).toBe(FINGERPRINT_A);
    expect(row.description).toBe('granted at an unreadable time');
  });
});

describe('git approvals — nothing to show (FR-R3-146)', () => {
  it('tells the operator there are none, and how one gets stored', async () => {
    const test = harness({ grants: {} });

    await runGitApprovals(test.deps);

    // "No approvals" and "this command is broken" look identical to someone who
    // just pressed the button, so the message names the act that creates one.
    expect(test.messages).toEqual([NO_APPROVALS_MESSAGE]);
    expect(test.offered).toHaveLength(0);
    expect(test.forgotten).toEqual([]);
    expect(test.forgetAllCalls).toEqual([]);
  });
});

describe('git approvals — withdrawing one (FR-R3-146, FR-013)', () => {
  it('forgets exactly the grant picked and leaves the rest', async () => {
    const test = harness({
      grants: mapOf(record(FINGERPRINT_A), record(FINGERPRINT_B)),
      pick: (items) => items.find((item) => item.fingerprint === FINGERPRINT_A)
    });

    await runGitApprovals(test.deps);

    expect(test.forgotten).toEqual([FINGERPRINT_A]);
    expect(Object.keys(test.remaining)).toEqual([FINGERPRINT_B]);
    expect(test.forgetAllCalls).toEqual([]);
  });

  it('reads the grants when it runs, never a map captured at wiring time', async () => {
    // research.md R3 for the settings half: a live read is what makes withdrawal
    // take effect without a window reload. The same argument applies here — a
    // captured map would list a grant a second window already withdrew.
    const test = harness({ grants: mapOf(record(FINGERPRINT_A)) });
    test.remaining = mapOf(record(FINGERPRINT_B));

    await runGitApprovals(test.deps);

    expect(test.offered[0]?.[0]?.fingerprint).toBe(FINGERPRINT_B);
  });

  it('confirms first, naming the plan and what withdrawal costs', async () => {
    const test = harness({ grants: mapOf(record(FINGERPRINT_A)) });

    await runGitApprovals(test.deps);

    expect(test.confirmations).toHaveLength(1);
    expect(test.confirmations[0]?.message).toContain('spec-driven');
    expect(test.confirmations[0]?.detail).toContain('ask again');
    expect(test.confirmations[0]?.approveLabel).toBe(FORGET_ONE_LABEL);
  });

  it('tells the operator the prompt will come back', async () => {
    const test = harness({ grants: mapOf(record(FINGERPRINT_A)) });

    await runGitApprovals(test.deps);

    // FR-012's second half — "removing either MUST restore the corresponding
    // prompt" — is the outcome the operator is choosing, so the confirmation is
    // where it is said, not a release note.
    expect(test.messages).toHaveLength(1);
    expect(test.messages[0]).toContain('ask again');
    expect(test.messages[0]).toContain('spec-driven');
  });

  it('reports a grant that was already gone as gone, not as a withdrawal', async () => {
    const test = harness({ grants: mapOf(record(FINGERPRINT_A)) });
    // The list was rendered, and then a second window withdrew it. `forget`
    // reports `false`, and telling this operator they just forgot it would be a
    // lie about a security decision they are relying on.
    const original = test.deps.grants;
    (test.deps as { grants: () => Record<string, GitApprovalRecord> }).grants = () => {
      const grants = original();
      test.remaining = {};
      return grants;
    };

    await runGitApprovals(test.deps);

    expect(test.forgotten).toEqual([FINGERPRINT_A]);
    expect(test.messages[0]).toContain('already gone');
  });
});

describe('git approvals — withdrawing all (FR-R3-146, FR-013)', () => {
  it('forgets everything and reports the count', async () => {
    const test = harness({
      grants: mapOf(record(FINGERPRINT_A), record(FINGERPRINT_B)),
      pick: (items) => items.find((item) => item.fingerprint === null)
    });

    await runGitApprovals(test.deps);

    expect(test.forgetAllCalls).toEqual([2]);
    expect(test.forgotten).toEqual([]);
    expect(test.remaining).toEqual({});
    expect(test.messages[0]).toContain('2 Git approvals');
  });

  it('confirms before it, with its own label', async () => {
    const test = harness({
      grants: mapOf(record(FINGERPRINT_A), record(FINGERPRINT_B)),
      pick: (items) => items.find((item) => item.fingerprint === null)
    });

    await runGitApprovals(test.deps);

    expect(test.confirmations[0]?.approveLabel).toBe(FORGET_ALL_LABEL);
    expect(test.confirmations[0]?.detail).toContain('ask again');
  });
});

describe('git approvals — only an affirmative answer acts (FR-R3-146, FR-002)', () => {
  it('changes nothing when the operator dismisses the list', async () => {
    const test = harness({
      grants: mapOf(record(FINGERPRINT_A), record(FINGERPRINT_B)),
      pick: () => undefined
    });

    await runGitApprovals(test.deps);

    expect(test.confirmations).toEqual([]);
    expect(test.forgotten).toEqual([]);
    expect(test.forgetAllCalls).toEqual([]);
    expect(Object.keys(test.remaining).sort()).toEqual([FINGERPRINT_A, FINGERPRINT_B].sort());
  });

  it('changes nothing when the operator picks a row and dismisses the confirmation', async () => {
    // The one that matters. This list is the OBSERVE half of FR-012, so an
    // operator opening it to read what they granted has to be able to click a row
    // without destroying it. Picking selects; the modal decides.
    const test = harness({
      grants: mapOf(record(FINGERPRINT_A), record(FINGERPRINT_B)),
      confirm: () => undefined
    });

    await runGitApprovals(test.deps);

    expect(test.confirmations).toHaveLength(1);
    expect(test.forgotten).toEqual([]);
    expect(Object.keys(test.remaining).sort()).toEqual([FINGERPRINT_A, FINGERPRINT_B].sort());
    expect(test.messages).toEqual([]);
  });

  it('changes nothing when the confirmation returns some other label', async () => {
    // VS Code resolves `showWarningMessage` to the label pressed, and a modal
    // carries a Cancel. Matching the affirmative label rather than testing for
    // truthiness is what makes "anything else keeps the grant" hold.
    const test = harness({
      grants: mapOf(record(FINGERPRINT_A)),
      confirm: () => 'Cancel'
    });

    await runGitApprovals(test.deps);

    expect(test.forgotten).toEqual([]);
    expect(Object.keys(test.remaining)).toEqual([FINGERPRINT_A]);
  });

  it('does not forget everything when the forget-all confirmation is declined', async () => {
    const test = harness({
      grants: mapOf(record(FINGERPRINT_A), record(FINGERPRINT_B)),
      pick: (items) => items.find((item) => item.fingerprint === null),
      confirm: () => undefined
    });

    await runGitApprovals(test.deps);

    expect(test.forgetAllCalls).toEqual([]);
    expect(Object.keys(test.remaining).sort()).toEqual([FINGERPRINT_A, FINGERPRINT_B].sort());
  });

  it('does not forget everything when the forget-all confirmation returns another label', async () => {
    // The forget-all twin of the `'Cancel'` case above, and it is here because it
    // was measured missing: with only the dismissal test, replacing
    // `approved !== FORGET_ALL_LABEL` with `!approved` kept the whole file green
    // while making every non-empty answer destroy every grant in the workspace.
    // Dismissal returns `undefined`, which both forms reject; a pressed Cancel
    // returns a string, which only the label comparison rejects.
    const test = harness({
      grants: mapOf(record(FINGERPRINT_A), record(FINGERPRINT_B)),
      pick: (items) => items.find((item) => item.fingerprint === null),
      confirm: () => 'Cancel'
    });

    await runGitApprovals(test.deps);

    expect(test.forgetAllCalls).toEqual([]);
    expect(Object.keys(test.remaining).sort()).toEqual([FINGERPRINT_A, FINGERPRINT_B].sort());
    expect(test.messages).toEqual([]);
  });
});
