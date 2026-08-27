// Feature 059 (US1, T008) — capability-trust-resolver unit tests.
// Covers the 16-row ladder matrix, listener wiring, getResolvedScope
// semantics, and disposal per
// `specs/059-fine-grained-trust-scopes/contracts/capability-trust-resolver-contract.md`.
//
// Feature 099 (T496f, FR-046) — the ladder had four capabilities and now has
// two: `pipelineOverrides` and `workflowOverrides` are deleted with the layer
// tier, because each asked which layer was permitted to redefine another's row.
// The ladder itself is untouched, so every case below is the same case over the
// two capabilities that gate document CONTENT rather than layering.
//
// FR-R3-108 (2026-08-26) — the ladder itself is no longer untouched. Deny now takes
// precedence at either scope; see the note on `expectedAllowed` below.
//
// Mock pattern mirrors `workspace-folder-picker.test.ts`: a `vi.hoisted`
// state record carrying `isTrusted`, a per-key `inspect()` map, and two
// listener sets (one for `onDidGrantWorkspaceTrust`, one for
// `onDidChangeConfiguration`).

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
    configListeners: new Set<ConfigListener>(),
    subscriptions: [] as { dispose: () => void }[]
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
      return {
        dispose: () => mocks.state.trustListeners.delete(listener)
      };
    },
    onDidChangeConfiguration: (listener: ConfigListener) => {
      mocks.state.configListeners.add(listener);
      return {
        dispose: () => mocks.state.configListeners.delete(listener)
      };
    }
  }
}));

import {
  isCapabilityAllowed,
  getResolvedCapabilities,
  getResolvedScope,
  initCapabilityTrustResolver,
  type TrustCapability
} from '../../../src/state/capability-trust-resolver';
import { resolveCapabilityDecision } from '../../../src/state/capability-trust-decision';

const KEYS: Record<TrustCapability, string> = {
  phases: 'schegent.trust.allowCustomPhases',
  retryConditions: 'schegent.trust.allowCustomRetryConditions'
};

/**
 * The two keys feature 099 removed from the ladder. Held here so the listener
 * can be asked about them: they must now be as uninteresting as any unrelated
 * setting, which a list that merely omits them could not assert.
 */
const DELETED_TRUST_KEYS = [
  'schegent.trust.allowPipelineOverrides',
  'schegent.trust.allowWorkflowOverrides'
] as const;

function setScope(
  capability: TrustCapability,
  workspaceValue: boolean | null,
  globalValue: boolean | null
): void {
  const key = KEYS[capability];
  const entry: InspectResult = {};
  if (workspaceValue !== null) entry.workspaceValue = workspaceValue;
  if (globalValue !== null) entry.globalValue = globalValue;
  mocks.state.inspectMap.set(key, entry);
}

function makeContext(): { subscriptions: { dispose: () => void }[] } {
  return { subscriptions: mocks.state.subscriptions };
}

beforeEach(() => {
  mocks.state.isTrusted = true;
  mocks.state.inspectMap.clear();
  mocks.state.trustListeners.clear();
  mocks.state.configListeners.clear();
  mocks.state.subscriptions = [];
});

describe('capability-trust-resolver (059, T008) — 16-row ladder matrix', () => {
  // Generate every combination of (isTrusted) x (workspace) x (user) for
  // every capability. Expected values match `data-model.md §2`.
  const trustValues = [true, false] as const;
  const settingValues = [true, false, null] as const;
  const capabilities: TrustCapability[] = ['phases', 'retryConditions'];

  // FR-R3-108 — DENY-PRECEDENCE. These two functions encoded the ladder as feature 059
  // shipped it: workspace scope consulted first, user scope only if the workspace was
  // silent. That was inverted for the case a trust control exists for — a repository's
  // checked-in `true` defeated a user's explicit `false` — so four rows of this matrix
  // were asserting the defect.
  //
  // The rows are not deleted and the matrix is not narrowed; the POLICY changed and the
  // expectation follows it. Two rows change verdict (`workspace=true, user=false` now
  // denies) and two change reported scope (`workspace=false, user=false` now reports
  // `user`, because the deny check reads user scope first and the reporter must name the
  // scope that actually decided).
  //
  // `tests/unit/state/capability-trust-matrix.test.ts` states the same policy as a
  // hand-written table rather than as logic, which is the better artifact for reading
  // the rule; this one keeps the exhaustive cross product including `isTrusted=false`.
  function expectedAllowed(
    isTrusted: boolean,
    workspace: boolean | null,
    user: boolean | null
  ): boolean {
    if (!isTrusted) return false;
    if (user === false || workspace === false) return false;
    // `!== null` rather than the true/false pair: the `=== false` guard above already returned,
    // so half of each pair was unreachable and read as a ladder rung that does nothing.
    if (workspace !== null) return workspace;
    if (user !== null) return user;
    return true;
  }

  function expectedScope(
    isTrusted: boolean,
    workspace: boolean | null,
    user: boolean | null
  ): 'user' | 'workspace' | 'workspace-trust' {
    if (!isTrusted) return 'workspace-trust';
    if (user === false) return 'user';
    if (workspace === false) return 'workspace';
    // Same simplification as the ladder above: the `=== false` guards already returned, so the
    // second half of each pair was unreachable.
    if (workspace !== null) return 'workspace';
    if (user !== null) return 'user';
    return 'workspace-trust';
  }

  // FR-R3-126 — the pure ladder, over the SAME oracle and one dimension wider.
  //
  // `resolveCapabilityDecision` is the extraction of this ladder out of the
  // vscode-reading wrapper (`src/state/capability-trust-decision.ts`). It is
  // asserted against `expectedAllowed` above rather than against a second oracle:
  // two ladder tables would be a trust control with two answers, which is the
  // duplicate-authority shape this round has removed repeatedly.
  //
  // ONE DIMENSION WIDER, and this is why the extraction earns its own rows: the
  // mock's `inspect()` can only produce `true`, `false` or `null`, while the real
  // API returns `undefined` for a key nobody has set. The wrapper cannot
  // distinguish them and the pure function can be asked directly, so the
  // `undefined` column is coverage the mocked rows above cannot reach.
  describe('resolveCapabilityDecision — the same ladder, without vscode', () => {
    const pureValues = [true, false, null, undefined] as const;
    for (const isTrusted of trustValues) {
      for (const workspace of pureValues) {
        for (const user of pureValues) {
          // `undefined` and `null` both mean "no override" (invariant I-3), so the
          // oracle is fed the `null` form for either.
          const asOracle = (value: boolean | null | undefined): boolean | null =>
            value === undefined ? null : value;
          const expected = expectedAllowed(isTrusted, asOracle(workspace), asOracle(user));
          it(`isTrusted=${isTrusted}, workspace=${String(workspace)}, user=${String(user)} → ${expected}`, () => {
            expect(
              resolveCapabilityDecision({
                isTrusted,
                workspaceValue: workspace,
                globalValue: user
              })
            ).toBe(expected);
          });
        }
      }
    }

    it('treats undefined exactly as null — no override, either way', () => {
      // Stated as its own assertion because the whole point of the wider column is
      // that the two absences must not diverge.
      for (const isTrusted of trustValues) {
        for (const other of pureValues) {
          expect(
            resolveCapabilityDecision({
              isTrusted,
              workspaceValue: undefined,
              globalValue: other
            })
          ).toBe(
            resolveCapabilityDecision({ isTrusted, workspaceValue: null, globalValue: other })
          );
        }
      }
    });

    it('is what the wrapper delegates to, so the extraction cannot stop being called', () => {
      // T014a. The mocked rows above exercise `isCapabilityAllowed`; this asserts
      // the two agree on a case that would diverge if the wrapper grew its own copy
      // of the ladder — an explicit deny at user scope against an explicit allow at
      // workspace scope, which is the pair FR-R3-108 re-expected.
      mocks.state.isTrusted = true;
      setScope('phases', true, false);
      expect(isCapabilityAllowed('phases')).toBe(
        resolveCapabilityDecision({ isTrusted: true, workspaceValue: true, globalValue: false })
      );
      expect(isCapabilityAllowed('phases')).toBe(false);
    });
  });

  for (const capability of capabilities) {
    for (const isTrusted of trustValues) {
      for (const workspace of settingValues) {
        for (const user of settingValues) {
          const label = `${capability}: isTrusted=${isTrusted}, workspace=${workspace}, user=${user}`;
          it(`${label} → allowed=${expectedAllowed(isTrusted, workspace, user)}, scope=${expectedScope(isTrusted, workspace, user)}`, () => {
            mocks.state.isTrusted = isTrusted;
            setScope(capability, workspace, user);
            expect(isCapabilityAllowed(capability)).toBe(
              expectedAllowed(isTrusted, workspace, user)
            );
            expect(getResolvedScope(capability)).toBe(
              expectedScope(isTrusted, workspace, user)
            );
          });
        }
      }
    }
  }
});

describe('capability-trust-resolver — getResolvedCapabilities composition', () => {
  it('returns workspaceTrust=true and both booleans aligned with the ladder', () => {
    // Each capability is given a DIFFERENT rung so the composition cannot pass
    // by reading one key twice: `phases` is decided at workspace scope, and
    // `retryConditions` falls through to user scope.
    mocks.state.isTrusted = true;
    setScope('phases', false, null);
    setScope('retryConditions', null, true);
    const out = getResolvedCapabilities();
    expect(out.workspaceTrust).toBe(true);
    expect(out.phases).toBe(false);
    expect(out.retryConditions).toBe(true);
  });

  it('untrusted workspace forces both to false', () => {
    mocks.state.isTrusted = false;
    setScope('phases', true, true);
    setScope('retryConditions', true, true);
    const out = getResolvedCapabilities();
    expect(out.workspaceTrust).toBe(false);
    expect(out.phases).toBe(false);
    expect(out.retryConditions).toBe(false);
  });

  it('carries no key for a capability the ladder no longer has', () => {
    // Feature 099 (T496f, FR-046) — the projection is read by the webview
    // TrustBanner, so a leftover key would keep a deleted capability alive in
    // the surface even with the ladder collapsed.
    const out = getResolvedCapabilities();
    for (const removed of ['pipelineOverrides', 'workflowOverrides']) {
      expect(out).not.toHaveProperty(removed);
    }
  });
});

describe('capability-trust-resolver — listener wiring & disposal', () => {
  it('subscribes to onDidGrantWorkspaceTrust and onDidChangeConfiguration; pushes disposables', () => {
    const ctx = makeContext();
    const onInvalidate = vi.fn();
    initCapabilityTrustResolver(ctx as any, onInvalidate);
    expect(mocks.state.trustListeners.size).toBe(1);
    expect(mocks.state.configListeners.size).toBe(1);
    expect(ctx.subscriptions.length).toBeGreaterThanOrEqual(2);
  });

  it('onDidGrantWorkspaceTrust firing calls onInvalidate', () => {
    const ctx = makeContext();
    const onInvalidate = vi.fn();
    initCapabilityTrustResolver(ctx as any, onInvalidate);
    for (const listener of mocks.state.trustListeners) listener();
    expect(onInvalidate).toHaveBeenCalledTimes(1);
  });

  it('config change for any trust key calls onInvalidate exactly once', () => {
    const ctx = makeContext();
    const onInvalidate = vi.fn();
    initCapabilityTrustResolver(ctx as any, onInvalidate);
    for (const listener of mocks.state.configListeners) {
      listener({
        affectsConfiguration: (k: string) => k === 'schegent.trust.allowCustomPhases'
      });
    }
    expect(onInvalidate).toHaveBeenCalledTimes(1);
  });

  it('config change for unrelated key does NOT call onInvalidate', () => {
    const ctx = makeContext();
    const onInvalidate = vi.fn();
    initCapabilityTrustResolver(ctx as any, onInvalidate);
    for (const listener of mocks.state.configListeners) {
      listener({
        affectsConfiguration: (k: string) => k === 'schegent.cli.path'
      });
    }
    expect(onInvalidate).not.toHaveBeenCalled();
  });

  it('config change for each remaining trust key (separately) fires once each', () => {
    const ctx = makeContext();
    const onInvalidate = vi.fn();
    initCapabilityTrustResolver(ctx as any, onInvalidate);
    const trustKeys = Object.values(KEYS);
    for (const targetKey of trustKeys) {
      for (const listener of mocks.state.configListeners) {
        listener({
          affectsConfiguration: (k: string) => k === targetKey
        });
      }
    }
    expect(onInvalidate).toHaveBeenCalledTimes(trustKeys.length);
  });

  it('config change for a deleted trust key does NOT call onInvalidate', () => {
    // Feature 099 (T496f, FR-046) — the pair above used to sit in this list. A
    // list that simply drops them would still pass if the listener kept
    // watching them; this asserts the watch went with the capability, so a
    // stale `schegent.trust.allowPipelineOverrides` left in a user's settings
    // cannot churn the projection.
    const ctx = makeContext();
    const onInvalidate = vi.fn();
    initCapabilityTrustResolver(ctx as any, onInvalidate);
    for (const removed of DELETED_TRUST_KEYS) {
      for (const listener of mocks.state.configListeners) {
        listener({ affectsConfiguration: (k: string) => k === removed });
      }
    }
    expect(onInvalidate).not.toHaveBeenCalled();
  });
});

describe('capability-trust-resolver — no-cache invariant (I-1)', () => {
  it('re-reads isTrusted on every call', () => {
    mocks.state.isTrusted = true;
    expect(isCapabilityAllowed('phases')).toBe(true);
    mocks.state.isTrusted = false;
    expect(isCapabilityAllowed('phases')).toBe(false);
    mocks.state.isTrusted = true;
    expect(isCapabilityAllowed('phases')).toBe(true);
  });

  it('re-reads inspect() result on every call', () => {
    mocks.state.isTrusted = true;
    setScope('phases', null, null);
    expect(isCapabilityAllowed('phases')).toBe(true);
    setScope('phases', false, null);
    expect(isCapabilityAllowed('phases')).toBe(false);
    setScope('phases', true, null);
    expect(isCapabilityAllowed('phases')).toBe(true);
  });
});

// Feature 083 (US1, T021) — `workflowOverrides` is a fourth capability, not a
// reuse of `pipelineOverrides`: permitting Pipeline edits in an untrusted
// workspace does not thereby permit Workflow-graph edits (research R8).
//
// Feature 099 (T496f, FR-046) — that pair is deleted, but the property this
// block defends is not about either of them: it is that a capability reads its
// OWN key and resolves on its OWN rung, so one capability cannot be satisfied
// by another's setting. With two capabilities left there is still a pair to
// assert it over, so every case below is re-anchored on `retryConditions`
// against `phases` rather than dropped.
describe('capability-trust-resolver — each capability reads only its own key', () => {
  it('reads schegent.trust.allowCustomRetryConditions and no other key', () => {
    mocks.state.isTrusted = true;
    setScope('phases', false, false);
    mocks.state.inspectMap.set('schegent.trust.allowCustomRetryConditions', {
      workspaceValue: true
    });
    expect(isCapabilityAllowed('retryConditions')).toBe(true);
    expect(isCapabilityAllowed('phases')).toBe(false);
  });

  it('stays independent of phases in both directions', () => {
    mocks.state.isTrusted = true;
    setScope('phases', null, true);
    setScope('retryConditions', null, false);
    expect(isCapabilityAllowed('phases')).toBe(true);
    expect(isCapabilityAllowed('retryConditions')).toBe(false);
    expect(getResolvedScope('retryConditions')).toBe('user');
  });

  it('honors the untrusted ceiling even with both capabilities set to true (I-2)', () => {
    mocks.state.isTrusted = false;
    setScope('retryConditions', true, true);
    expect(isCapabilityAllowed('retryConditions')).toBe(false);
    expect(getResolvedScope('retryConditions')).toBe('workspace-trust');
  });

  it('is read fresh on every call rather than cached (I-1)', () => {
    mocks.state.isTrusted = true;
    setScope('retryConditions', null, null);
    expect(isCapabilityAllowed('retryConditions')).toBe(true);
    setScope('retryConditions', false, null);
    expect(isCapabilityAllowed('retryConditions')).toBe(false);
    setScope('retryConditions', true, null);
    expect(isCapabilityAllowed('retryConditions')).toBe(true);
    mocks.state.isTrusted = false;
    expect(isCapabilityAllowed('retryConditions')).toBe(false);
  });

  it('invalidates the projection when its own key changes', () => {
    const ctx = makeContext();
    const onInvalidate = vi.fn();
    initCapabilityTrustResolver(ctx as any, onInvalidate);
    for (const listener of mocks.state.configListeners) {
      listener({
        affectsConfiguration: (k: string) =>
          k === 'schegent.trust.allowCustomRetryConditions'
      });
    }
    expect(onInvalidate).toHaveBeenCalledTimes(1);
  });
});
