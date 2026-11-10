// FR-R3-144 (T022, T023, T048) — the projection agrees with the policy, for every
// backend, including ones that do not exist yet.
//
// Every assertion here enumerates `SUPPORTED_BACKENDS` rather than naming
// `'claude'`, `'codex'` and `'agy'`. That is the point of the tests, not a style
// preference: a row added to `MECHANISM_BY_BACKEND` for a fourth backend must fail
// this file on the day it is added if `composeBackendPostures` was not taught about
// it, and a test that named three ids would pass while the new backend rendered
// nothing. Where a specific id IS named below it is because the case is about that
// id's particular policy — `codex` is the only OS-enforced backend today, and A-2 is
// about exactly that asymmetry.

import { describe, expect, it } from 'vitest';
import { composeBackendPostures } from '../../../../src/ui/sidebar/backend-posture-projection';
import { workflowSnapshot } from '../../../visual/fixtures/workflow-snapshot';
import {
  SUPPORTED_BACKENDS,
  type BackendRunnerKind
} from '../../../../src/contracts/backend-kinds';
import {
  containmentOf,
  judgeBackendContainment,
  mechanismOf,
  resolveUncontainedGrant
} from '../../../../src/services/backend-containment-policy';

const UNCONTAINED = SUPPORTED_BACKENDS.filter((kind) => containmentOf(kind) !== 'os-enforced');
const OS_ENFORCED = SUPPORTED_BACKENDS.filter((kind) => containmentOf(kind) === 'os-enforced');

function postureOf(kinds: readonly BackendRunnerKind[], kind: BackendRunnerKind) {
  return composeBackendPostures(kinds).backendPostures.find((row) => row.kind === kind);
}

describe('FR-R3-144 T022 — the projection is the policy, not a copy of it (D-4)', () => {
  it('projects one row per supported backend, in the enumeration order', () => {
    const { backendPostures } = composeBackendPostures([]);

    expect(backendPostures.map((row) => row.kind)).toEqual([...SUPPORTED_BACKENDS]);
  });

  it.each([...SUPPORTED_BACKENDS])(
    'projects %s with the containment and mechanism the policy functions answer',
    (kind) => {
      const row = postureOf([], kind);

      // Compared against the live policy call, never against a literal. A literal
      // would be a second copy of `MECHANISM_BY_BACKEND` that this test then proved
      // consistent with itself.
      expect(row).toBeDefined();
      expect(row?.containment).toBe(containmentOf(kind));
      expect(row?.mechanism).toBe(mechanismOf(kind));
    }
  );

  it('carries no problem on a well-formed setting', () => {
    const projection = composeBackendPostures([...UNCONTAINED]);

    // Absent, not `undefined`-valued: a row that ships the key makes the ordinary
    // case look like it carries a fact.
    for (const row of projection.backendPostures) {
      expect(Object.hasOwn(row, 'problem')).toBe(false);
    }
    expect(projection.backendGrantProblems).toEqual([]);
  });

  it('fails closed on a setting that is not a list of ids', () => {
    // An unwired host hands `undefined` over; `resolveUncontainedGrant` fails closed
    // on it, so the projection reports the same posture a fresh install reports.
    for (const raw of [undefined, null, 'claude', 42, { claude: true }]) {
      const projection = composeBackendPostures(raw);

      expect(projection.backendPostures.map((row) => row.grant)).toEqual(
        SUPPORTED_BACKENDS.map((kind) =>
          containmentOf(kind) === 'os-enforced' ? 'not-required' : 'not-granted'
        )
      );
    }
  });
});

describe('FR-R3-144 T048 — three grant states, and which backend can be in each (A-2)', () => {
  it.each([...UNCONTAINED])('reports %s as not-granted until it is listed, then granted', (kind) => {
    expect(postureOf([], kind)?.grant).toBe('not-granted');
    expect(postureOf([kind], kind)?.grant).toBe('granted');
  });

  it.each([...OS_ENFORCED])(
    'reports %s as not-required until listed, then granted (FR-R6-F09 R4)',
    (kind) => {
      // FR-R6-F09 made an OS-enforced backend grantable: its mechanism is qualified
      // per tuple, and on an unqualified one the grant is the acceptance. Listed, it
      // is in the granted set, so the row says so.
      expect(resolveUncontainedGrant([kind]).granted.has(kind)).toBe(true);

      expect(postureOf([], kind)?.grant).toBe('not-required');
      expect(postureOf([kind], kind)?.grant).toBe('granted');
    }
  );

  it('never reports a grant state outside the three the contract declares', () => {
    const seen = new Set(
      [[], [...SUPPORTED_BACKENDS]].flatMap((raw) =>
        composeBackendPostures(raw).backendPostures.map((row) => row.grant)
      )
    );

    for (const state of seen) {
      expect(['granted', 'not-granted', 'not-required']).toContain(state);
    }
  });

  it('leaves every other backend alone when one is granted', () => {
    // `.at(0)` and a throw, rather than a destructure and an early return. The
    // head of an array is TYPED as present, so a guard written against `[0]` reads
    // as dead syntax to `no-unnecessary-condition` while the
    // `noUncheckedIndexedAccess` ratchet counts an unguarded read as a new site;
    // `.at()` is `| undefined` under both. And it throws rather than returns
    // because with no uncontained backend there is nothing to grant — an early
    // return would let this test pass by running its assertions over an empty list.
    const first = UNCONTAINED.at(0);
    if (first === undefined) throw new Error('no uncontained backend to grant');
    const rest = UNCONTAINED.slice(1);

    const projection = composeBackendPostures([first]);

    expect(postureOf([first], first)?.grant).toBe('granted');
    for (const kind of rest) {
      expect(projection.backendPostures.find((row) => row.kind === kind)?.grant).toBe(
        'not-granted'
      );
    }
  });
});

describe('FR-R3-144 T023 — a malformed grant entry becomes visible (FR-004)', () => {
  it('surfaces an entry that names no backend, on the projection rather than nowhere', () => {
    const typo = 'claud';
    const projection = composeBackendPostures([typo, 'claude']);

    // `"claud"` matches no row, so it has nothing to hang off — it travels in
    // `backendGrantProblems`. Without that field the entry would be tolerated on
    // the way in (FR-004) and then invisible everywhere, which is the state this
    // feature ends.
    expect(projection.backendGrantProblems).toHaveLength(1);
    expect(projection.backendGrantProblems[0]).toContain(typo);
    expect(projection.backendGrantProblems[0]).toBe(
      resolveUncontainedGrant([typo, 'claude']).problems[0]?.message
    );

    // And the valid neighbour is still honoured — one bad entry does not void the
    // list.
    expect(postureOf(['claude'], 'claude')?.grant).toBe('granted');
    expect(projection.backendPostures.some((row) => row.problem !== undefined)).toBe(false);
  });

  it.each([...OS_ENFORCED])('carries no problem when %s is listed (FR-R6-F09 R4)', (kind) => {
    const projection = composeBackendPostures([kind]);
    const row = projection.backendPostures.find((entry) => entry.kind === kind);

    expect(row !== undefined && Object.hasOwn(row, 'problem')).toBe(false);
    expect(projection.backendGrantProblems).toEqual([]);
  });

  it('reports a problem without changing what is granted', () => {
    const projection = composeBackendPostures(['claud', ...OS_ENFORCED]);

    expect(projection.backendGrantProblems).toHaveLength(1);
    for (const row of projection.backendPostures) {
      expect(row.grant).toBe(containmentOf(row.kind) === 'os-enforced' ? 'granted' : 'not-granted');
    }
  });
});

// The refusal sentence is the one thing on this projection an operator ACTS on:
// it names the setting, the value to add, and the scope. Every assertion below
// compares it against `judgeBackendContainment`'s live output rather than against
// a copy of the sentence, so rewording the policy cannot break these tests — only
// projecting something OTHER than the policy's wording can.
describe('FR-R3-144 T033/T035 — the refusal is carried, not re-typed', () => {
  it.each([...UNCONTAINED])(
    'carries %s\'s refusal verbatim from the policy while it is ungranted',
    (kind) => {
      const refused = judgeBackendContainment(kind, new Set());
      // Guards the assertion below against a policy change that stops refusing:
      // without this, `refusal === undefined` would satisfy an `undefined` expected.
      expect(refused.outcome).toBe('refused');
      expect(postureOf([], kind)?.refusal).toBe(
        refused.outcome === 'refused' ? refused.message : undefined
      );
    }
  );

  it.each([...UNCONTAINED])('drops %s\'s refusal the moment the grant is in force', (kind) => {
    expect(postureOf([kind], kind)?.grant).toBe('granted');
    expect(Object.hasOwn(postureOf([kind], kind) ?? {}, 'refusal')).toBe(false);
  });

  it.each([...OS_ENFORCED])('never refuses %s, which needs no grant', (kind) => {
    // Listed or not: an OS-enforced backend has nothing to refuse, so a refusal
    // sentence on its row would be a screen telling an operator to grant a
    // permission the control for it correctly refuses to offer.
    expect(Object.hasOwn(postureOf([], kind) ?? {}, 'refusal')).toBe(false);
    expect(Object.hasOwn(postureOf([kind], kind) ?? {}, 'refusal')).toBe(false);
  });

  it('carries a refusal on exactly the rows whose grant is not-granted', () => {
    for (const setting of [[], [...UNCONTAINED], [...OS_ENFORCED], ['claud']]) {
      for (const row of composeBackendPostures(setting).backendPostures) {
        expect(Object.hasOwn(row, 'refusal')).toBe(row.grant === 'not-granted');
      }
    }
  });

  it('names the setting an operator must edit, so the sentence is actionable', () => {
    // Not a wording assertion — a usefulness one. The projection is what the tab
    // and the grant confirmation show, and a refusal that did not name the setting
    // would leave an operator with a "no" and no way to answer it.
    for (const row of composeBackendPostures([]).backendPostures) {
      if (row.refusal === undefined) continue;
      expect(row.refusal).toContain('backend.uncontainedBackends');
      expect(row.refusal).toContain(row.kind);
    }
  });
});

describe('FR-R3-144 T044 — the photographed frame is the frame a cold workspace gets', () => {
  it('matches the visual suite’s fixture, row for row', () => {
    // The visual fixture is `as const` literals on purpose — a captured frame that
    // a moving default must not move underneath. What it must not be is a frame of
    // a surface that does not exist: its own comment claims the postures are what
    // `composeBackendPostures([])` returns, and until this ran, nothing held it to
    // that. It had already drifted — every refusal sentence was missing, so three
    // screenshots photographed a tab with no refusal on it while a fresh install
    // shows two.
    //
    // Ordering is normalised away because it is not what this asserts: the sections
    // render in `SUPPORTED_BACKENDS` order regardless of the array's order, and the
    // claim here is about the CONTENT of each row. That the rendered order follows
    // the enumeration is asserted in the webview, where the order is decided.
    const byKind = (rows: readonly { readonly kind: string }[]) =>
      [...rows].sort((a, b) => a.kind.localeCompare(b.kind));

    expect(byKind(workflowSnapshot.backendPostures)).toEqual(
      byKind(composeBackendPostures([]).backendPostures)
    );
    expect(workflowSnapshot.backendGrantProblems).toEqual(
      composeBackendPostures([]).backendGrantProblems
    );
  });
});

// FR-R4-F06 (FR-007, FR-009; T5; contract D, D1 and D2) -- a granted uncontained
// backend's posture carries a host sentence saying what the grant means, and nothing
// else does. The sentence is the disclosure the launch surfaces render; the webview
// builds none of it (hard rule 2), so what is pinned here is the one place it is
// built. Enumerated over `SUPPORTED_BACKENDS` for the reason the file's header gives.
describe('FR-R4-F06 T5 -- a granted uncontained backend carries a host notice (D1, D2)', () => {
  it.each([...UNCONTAINED])('carries a notice on %s exactly while it is granted', (kind) => {
    expect(Object.hasOwn(postureOf([kind], kind) ?? {}, 'notice')).toBe(true);
    expect(typeof postureOf([kind], kind)?.notice).toBe('string');
  });

  it.each([...UNCONTAINED])('omits the notice key on %s while it is not granted', (kind) => {
    const row = postureOf([], kind);
    expect(row?.grant).toBe('not-granted');
    // Absent, not `undefined`-valued: the ordinary case must not look like it carries a fact.
    expect('notice' in (row ?? {})).toBe(false);
  });

  it.each([...OS_ENFORCED])('never carries a notice on %s, listed or not', (kind) => {
    expect('notice' in (postureOf([], kind) ?? {})).toBe(false);
    expect('notice' in (postureOf([kind], kind) ?? {})).toBe(false);
  });

  it('carries a notice on exactly the rows that are uncontained and granted', () => {
    for (const setting of [[], [...UNCONTAINED], [...OS_ENFORCED], ['claud'], [...SUPPORTED_BACKENDS]]) {
      for (const row of composeBackendPostures(setting).backendPostures) {
        const shouldCarry = row.containment === 'none' && row.grant === 'granted';
        expect(Object.hasOwn(row, 'notice')).toBe(shouldCarry);
      }
    }
  });

  it('never carries a notice and a refusal on one row', () => {
    for (const setting of [[], [...UNCONTAINED], [...OS_ENFORCED], [...SUPPORTED_BACKENDS]]) {
      for (const row of composeBackendPostures(setting).backendPostures) {
        expect(Object.hasOwn(row, 'notice') && Object.hasOwn(row, 'refusal')).toBe(false);
      }
    }
  });

  it.each([...UNCONTAINED])('states the authority %s runs with, in the pinned words', (kind) => {
    const notice = postureOf([kind], kind)?.notice ?? '';
    expect(notice).toContain('no OS-enforced bound');
    expect(notice).toContain('with your local user authority');
    expect(notice).toContain('application-scoped');
    expect(notice).toContain('in every trusted workspace in this installation');
    expect(notice).toContain('this backend only');
    expect(notice).toContain('Settings');
    // The backend is named by its display name, never by a path or operator text.
    expect(notice.toLowerCase()).toContain(kind);
  });

  it('is built from the validated kind alone', () => {
    // Two different settings that grant the same backend give the same sentence, so no
    // operator-authored text can have reached it.
    const first = postureOf(['claude'], 'claude')?.notice;
    const second = composeBackendPostures(['claude', 'claud', 42]).backendPostures.find(
      (row) => row.kind === 'claude'
    )?.notice;
    expect(first).toBeDefined();
    expect(second).toBe(first);
  });
});
