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

  function expectedAllowed(
    isTrusted: boolean,
    workspace: boolean | null,
    user: boolean | null
  ): boolean {
    if (!isTrusted) return false;
    if (workspace === true || workspace === false) return workspace;
    if (user === true || user === false) return user;
    return true;
  }

  function expectedScope(
    isTrusted: boolean,
    workspace: boolean | null,
    user: boolean | null
  ): 'user' | 'workspace' | 'workspace-trust' {
    if (!isTrusted) return 'workspace-trust';
    if (workspace === true || workspace === false) return 'workspace';
    if (user === true || user === false) return 'user';
    return 'workspace-trust';
  }

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
