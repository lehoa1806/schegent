// FR-R3-108 (FR-083..FR-087) — deny wins the trust ladder.
//
// THE INVERSION. `schegent.trust.*` are *trust* controls, and their ladder was
// inverted for exactly the scenario trust controls exist for. A user who set `false` at
// user scope opened a repository whose `.vscode/settings.json` — content that arrived
// **with the workspace** — set `true`, and the workspace won:
//
//   if (isExplicitBoolean(workspaceValue)) return workspaceValue;   // workspace wins
//   if (isExplicitBoolean(globalValue)) return globalValue;         // user consulted
//                                                                  //   only if silent
//
// Every sibling hardening went the other way: application-scoped settings exist
// precisely so a repository cannot redirect `cliPath` or flip containment (FR-R3-051).
// This one handed the workspace the override.
//
// WHY MEDIUM AND NOT HIGH, kept here so the fix is not read as bigger than it is: VS
// Code workspace trust is a real ceiling, and an untrusted window resolves `false`
// regardless. The attack needs a **trusted-but-hostile** workspace. That is also
// precisely the case an explicit user-scope `false` describes an operator trying to
// defend against.
//
// BOTH CAPABILITIES, one resolver. The source item says only `allowCustomPhases` was
// found inverted and warns against refactoring resolvers that are already correct. The
// sweep's answer is that **there is no second resolver**: `isCapabilityAllowed` is
// parameterised by capability, and both capabilities read the same ladder. So one fix
// covers both, and this matrix runs over both so neither can regress alone.
import { describe, it, expect, vi, beforeEach } from 'vitest';

type TrustListener = () => void;
type ConfigListener = (event: { affectsConfiguration: (key: string) => boolean }) => void;

interface InspectResult {
  globalValue?: unknown;
  workspaceValue?: unknown;
}

const mocks = vi.hoisted(() => {
  const state = {
    isTrusted: true as boolean,
    inspectMap: new Map<string, InspectResult>(),
    trustListeners: new Set<TrustListener>(),
    configListeners: new Set<ConfigListener>()
  };
  return { state };
});

vi.mock('vscode', () => ({
  workspace: {
    get isTrusted() {
      return mocks.state.isTrusted;
    },
    getConfiguration: () => ({
      inspect: (key: string) => mocks.state.inspectMap.get(key) ?? {}
    }),
    onDidGrantWorkspaceTrust: (listener: TrustListener) => {
      mocks.state.trustListeners.add(listener);
      return { dispose: () => mocks.state.trustListeners.delete(listener) };
    },
    onDidChangeConfiguration: (listener: ConfigListener) => {
      mocks.state.configListeners.add(listener);
      return { dispose: () => mocks.state.configListeners.delete(listener) };
    }
  }
}));

import {
  isCapabilityAllowed,
  getResolvedScope
} from '../../../src/state/capability-trust-resolver';

const KEYS = {
  phases: 'schegent.trust.allowCustomPhases',
  retryConditions: 'schegent.trust.allowCustomRetryConditions'
} as const;

type Capability = keyof typeof KEYS;
type Setting = true | false | undefined;

const CAPABILITIES: readonly Capability[] = ['phases', 'retryConditions'];
const VALUES: readonly Setting[] = [true, false, undefined];

function set(capability: Capability, user: Setting, workspace: Setting): void {
  mocks.state.inspectMap.set(KEYS[capability], {
    globalValue: user,
    workspaceValue: workspace
  });
}

/**
 * The ladder, stated once as a table so the expectation is readable as a policy rather
 * than derived by the same logic it is testing.
 *
 * `[user, workspace] -> resolved`
 */
const LADDER: ReadonlyArray<{ user: Setting; workspace: Setting; allowed: boolean; note: string }> = [
  // An explicit deny at EITHER scope wins. This is the whole change.
  { user: false, workspace: true, allowed: false, note: 'THE INVERSION: a repository must not defeat a user deny' },
  { user: false, workspace: false, allowed: false, note: 'both deny' },
  { user: false, workspace: undefined, allowed: false, note: 'user denies, workspace silent' },
  { user: true, workspace: false, allowed: false, note: 'workspace denies; a deny wins from either side' },
  { user: undefined, workspace: false, allowed: false, note: 'workspace denies, user silent' },

  // A workspace `true` is effective only where the user is silent or allowing.
  { user: true, workspace: true, allowed: true, note: 'both allow' },
  { user: true, workspace: undefined, allowed: true, note: 'user allows, workspace silent' },
  { user: undefined, workspace: true, allowed: true, note: 'workspace allows, user silent' },

  // Silence everywhere. Recorded default: allow when the workspace is trusted, which is
  // what `null` in the manifest has always meant ("follow Workspace Trust").
  { user: undefined, workspace: undefined, allowed: true, note: 'silent everywhere: follow workspace trust' }
];

beforeEach(() => {
  mocks.state.isTrusted = true;
  mocks.state.inspectMap.clear();
});

describe('FR-R3-108 — an explicit deny at either scope wins', () => {
  for (const capability of CAPABILITIES) {
    describe(capability, () => {
      for (const row of LADDER) {
        it(`user=${String(row.user)} workspace=${String(row.workspace)} -> ${String(row.allowed)} (${row.note})`, () => {
          set(capability, row.user, row.workspace);
          expect(isCapabilityAllowed(capability)).toBe(row.allowed);
        });
      }
    });
  }

  it('covers all nine cells for both capabilities, so no combination is untested', () => {
    // The matrix is hand-written above for readability; this asserts it is complete
    // against the cross product, so a row cannot be quietly dropped.
    const covered = new Set(LADDER.map((r) => `${String(r.user)}|${String(r.workspace)}`));
    const expected = new Set(
      VALUES.flatMap((u) => VALUES.map((w) => `${String(u)}|${String(w)}`))
    );
    expect([...covered].sort()).toEqual([...expected].sort());
    expect(CAPABILITIES.length).toBe(2);
  });

  it('workspace trust remains the outer gate, whatever the overrides say', () => {
    mocks.state.isTrusted = false;
    for (const capability of CAPABILITIES) {
      for (const row of LADDER) {
        set(capability, row.user, row.workspace);
        expect(
          isCapabilityAllowed(capability),
          `untrusted workspace must deny ${capability} at user=${String(row.user)} ` +
            `workspace=${String(row.workspace)}`
        ).toBe(false);
      }
    }
  });
});

describe('FR-R3-108 — the resolved-scope reporter agrees with the resolver', () => {
  it('reports the scope that actually decided, at every cell', () => {
    for (const capability of CAPABILITIES) {
      for (const row of LADDER) {
        set(capability, row.user, row.workspace);
        const scope = getResolvedScope(capability);
        const allowed = isCapabilityAllowed(capability);

        // The reporter must never name a scope whose value contradicts the decision.
        // That is the agreement worth pinning: an operator reading "workspace" while the
        // workspace value was overruled has been told the wrong thing.
        if (scope === 'user') {
          expect(row.user, `${capability}: reported user scope`).toBe(allowed);
        } else if (scope === 'workspace') {
          expect(row.workspace, `${capability}: reported workspace scope`).toBe(allowed);
        } else {
          // 'workspace-trust' — reached only when no explicit override decided.
          expect(
            row.user === undefined && row.workspace === undefined,
            `${capability}: reported workspace-trust at user=${String(row.user)} ` +
              `workspace=${String(row.workspace)}, but an explicit override was present`
          ).toBe(true);
        }
      }
    }
  });

  it('names the DENYING scope when a deny wins, not the scope that was overruled', () => {
    // The inversion case, from the reporter's side. Before the fix it said 'workspace'
    // while the answer came from the user's deny.
    set('phases', false, true);
    expect(isCapabilityAllowed('phases')).toBe(false);
    expect(getResolvedScope('phases')).toBe('user');
  });
});
