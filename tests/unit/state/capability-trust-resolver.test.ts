// Feature 059 (US1, T008) — capability-trust-resolver unit tests.
// Covers the 16-row ladder matrix, listener wiring, getResolvedScope
// semantics, and disposal per
// `specs/059-fine-grained-trust-scopes/contracts/capability-trust-resolver-contract.md`.
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
  retryConditions: 'schegent.trust.allowCustomRetryConditions',
  pipelineOverrides: 'schegent.trust.allowPipelineOverrides'
};

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
  const capabilities: TrustCapability[] = ['phases', 'retryConditions', 'pipelineOverrides'];

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
  it('returns workspaceTrust=true and three booleans aligned with the ladder', () => {
    mocks.state.isTrusted = true;
    setScope('phases', false, null);
    setScope('retryConditions', null, true);
    setScope('pipelineOverrides', null, null);
    const out = getResolvedCapabilities();
    expect(out.workspaceTrust).toBe(true);
    expect(out.phases).toBe(false);
    expect(out.retryConditions).toBe(true);
    expect(out.pipelineOverrides).toBe(true);
  });

  it('untrusted workspace forces all three to false', () => {
    mocks.state.isTrusted = false;
    setScope('phases', true, true);
    setScope('retryConditions', true, true);
    setScope('pipelineOverrides', true, true);
    const out = getResolvedCapabilities();
    expect(out.workspaceTrust).toBe(false);
    expect(out.phases).toBe(false);
    expect(out.retryConditions).toBe(false);
    expect(out.pipelineOverrides).toBe(false);
  });
});

describe('capability-trust-resolver — listener wiring & disposal', () => {
  it('subscribes to onDidGrantWorkspaceTrust and onDidChangeConfiguration; pushes disposables', () => {
    const ctx = makeContext();
    const onInvalidate = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    initCapabilityTrustResolver(ctx as any, onInvalidate);
    expect(mocks.state.trustListeners.size).toBe(1);
    expect(mocks.state.configListeners.size).toBe(1);
    expect(ctx.subscriptions.length).toBeGreaterThanOrEqual(2);
  });

  it('onDidGrantWorkspaceTrust firing calls onInvalidate', () => {
    const ctx = makeContext();
    const onInvalidate = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    initCapabilityTrustResolver(ctx as any, onInvalidate);
    for (const listener of mocks.state.trustListeners) listener();
    expect(onInvalidate).toHaveBeenCalledTimes(1);
  });

  it('config change for any trust key calls onInvalidate exactly once', () => {
    const ctx = makeContext();
    const onInvalidate = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    initCapabilityTrustResolver(ctx as any, onInvalidate);
    for (const listener of mocks.state.configListeners) {
      listener({
        affectsConfiguration: (k: string) => k === 'schegent.cli.path'
      });
    }
    expect(onInvalidate).not.toHaveBeenCalled();
  });

  it('config change for any of the three trust keys (separately) fires once each', () => {
    const ctx = makeContext();
    const onInvalidate = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    initCapabilityTrustResolver(ctx as any, onInvalidate);
    const trustKeys = [
      'schegent.trust.allowCustomPhases',
      'schegent.trust.allowCustomRetryConditions',
      'schegent.trust.allowPipelineOverrides'
    ];
    for (const targetKey of trustKeys) {
      for (const listener of mocks.state.configListeners) {
        listener({
          affectsConfiguration: (k: string) => k === targetKey
        });
      }
    }
    expect(onInvalidate).toHaveBeenCalledTimes(trustKeys.length);
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
