// Feature 059 (US5, T021) — state-projector trust-projection unit tests.
// Contract: specs/059-fine-grained-trust-scopes/contracts/trust-projection-contract.md
//
// Covers the four bullets under "Test coverage" in the contract:
//   1. Resolver returns trust=true everywhere → projection has the
//      `true` values (`workspaceTrust`, `resolvedTrust.{phases,
//      retryConditions}`).
//   2. Resolver returns trust=false → projection contains those
//      `false` values.
//   3. Resolver throws → projection falls back to fail-closed defaults
//      (all `false`) and `logger.warn` is called once.
//   4. `onProjectionInvalidated` fires N times → projector pushes N
//      snapshots (one per invalidation via the existing `kick()` path).
//
// The resolver is mocked at module scope per the same pattern used in
// `cmd-save-phases.test.ts` / `cmd-save-pipelines.test.ts`. This lets the
// test drive the resolver's return value or force it to throw without
// instantiating the real `vscode.workspace` surface.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const state = {
    nextReturn: {
      workspaceTrust: true,
      phases: true,
      retryConditions: true
    } as {
      workspaceTrust: boolean;
      phases: boolean;
      retryConditions: boolean;
    },
    // FR-R3-143 (T036) — the projection now also carries WHICH ladder step decided.
    nextScope: {
      phases: 'workspace-trust',
      retryConditions: 'workspace-trust'
    } as {
      phases: 'user' | 'workspace' | 'workspace-trust';
      retryConditions: 'user' | 'workspace' | 'workspace-trust';
    },
    throwOnNext: false as boolean,
    callCount: 0 as number
  };
  return { state };
});

// FR-R3-143 (T036) — `getResolvedScope` is mocked HERE, not left off.
//
// It was left off for the length of one edit, and the result is worth recording:
// `composeTrustProjection` called `undefined`, the `try` caught the TypeError, and
// the two happy-path cases below quietly became fail-closed cases that asserted
// `true` and got `false`. The fail-closed contract did its job — but a factory mock
// replaces the WHOLE module, so anything the module under test starts calling is
// `undefined` until someone adds it here.
vi.mock('../../../src/state/capability-trust-resolver', () => ({
  getResolvedCapabilities: () => {
    mocks.state.callCount += 1;
    if (mocks.state.throwOnNext) {
      throw new Error('resolver boom');
    }
    return { ...mocks.state.nextReturn };
  },
  getResolvedScope: (capability: 'phases' | 'retryConditions') => {
    if (mocks.state.throwOnNext) {
      throw new Error('resolver boom');
    }
    return mocks.state.nextScope[capability];
  }
}));

import { StateProjector } from '../../../src/ui/sidebar/state-projector';
import type { WorkflowSnapshot } from '../../../src/ui/sidebar/snapshot';

interface TrustFields {
  workspaceTrust: boolean;
  resolvedTrust: {
    phases: boolean;
    retryConditions: boolean;
  };
  resolvedScope: {
    phases: 'user' | 'workspace' | 'workspace-trust';
    retryConditions: 'user' | 'workspace' | 'workspace-trust';
  };
}

function readTrust(snap: WorkflowSnapshot): TrustFields {
  const anySnap = snap as unknown as Partial<TrustFields>;
  return {
    workspaceTrust: anySnap.workspaceTrust as boolean,
    resolvedTrust: anySnap.resolvedTrust as TrustFields['resolvedTrust'],
    resolvedScope: anySnap.resolvedScope as TrustFields['resolvedScope']
  };
}

function buildLogger() {
  const warnings: string[] = [];
  const logger = {
    info: vi.fn(),
    warn: (msg: string) => warnings.push(msg),
    error: vi.fn(),
    debug: vi.fn(),
    sanitize: (s: string) => s
  };
  return { logger, warnings };
}

function makeProjector(logger: ReturnType<typeof buildLogger>['logger']): StateProjector {
  return new StateProjector({
    ownerId: 'trust-test-owner',
    debounceMs: 0,
    logger: logger as any
  });
}

beforeEach(() => {
  // Feature 099 (T492, T496f, FR-046) — `pipelineOverrides` and
  // `workflowOverrides` are deleted with the layer tier they guarded: they asked
  // whether one layer could redefine what another declares, and one layer poses
  // no such question. Two capabilities remain, and every claim below is about
  // them; the deleted pair is pinned as an absence in the happy-path case.
  mocks.state.nextReturn = {
    workspaceTrust: true,
    phases: true,
    retryConditions: true
  };
  mocks.state.nextScope = {
    phases: 'workspace-trust',
    retryConditions: 'workspace-trust'
  };
  mocks.state.throwOnNext = false;
  mocks.state.callCount = 0;
});

describe('state-projector trust projection (059, T021) — happy path', () => {
  it('emits all-true trust fields when the resolver reports trust=true everywhere', () => {
    const { logger, warnings } = buildLogger();
    const projector = makeProjector(logger);
    const snap = projector.project();
    const trust = readTrust(snap);
    expect(trust.workspaceTrust).toBe(true);
    expect(trust.resolvedTrust.phases).toBe(true);
    expect(trust.resolvedTrust.retryConditions).toBe(true);
    expect(trust.resolvedTrust).not.toHaveProperty('pipelineOverrides');
    expect(trust.resolvedTrust).not.toHaveProperty('workflowOverrides');
    expect(warnings).toEqual([]);
    projector.dispose();
  });

  it('emits the resolver values when capabilities differ (granular)', () => {
    // The granular claim needs two capabilities that disagree, and the surviving
    // pair supplies exactly that: one denied, one allowed, in the same pass.
    mocks.state.nextReturn = {
      workspaceTrust: true,
      phases: false,
      retryConditions: true
    };
    const { logger } = buildLogger();
    const projector = makeProjector(logger);
    const trust = readTrust(projector.project());
    expect(trust.workspaceTrust).toBe(true);
    expect(trust.resolvedTrust.phases).toBe(false);
    expect(trust.resolvedTrust.retryConditions).toBe(true);
    projector.dispose();
  });

  it('carries the deciding step per capability, not one value for both', () => {
    // FR-R3-143 (T036) — the case the field exists for: one capability denied by
    // the user's own setting, the other untouched. A projection that reported a
    // single scope, or reported `workspace` for both, is what
    // `TrustBanner.svelte:33-42` was reading when it told operators their
    // workspace had disabled something their user settings had.
    mocks.state.nextReturn = {
      workspaceTrust: true,
      phases: false,
      retryConditions: true
    };
    mocks.state.nextScope = { phases: 'user', retryConditions: 'workspace-trust' };
    const { logger } = buildLogger();
    const projector = makeProjector(logger);
    const trust = readTrust(projector.project());
    expect(trust.resolvedScope.phases).toBe('user');
    expect(trust.resolvedScope.retryConditions).toBe('workspace-trust');
    projector.dispose();
  });
});

describe('state-projector trust projection (059, T021) — untrusted workspace', () => {
  it('emits all-false trust fields when workspaceTrust is false', () => {
    mocks.state.nextReturn = {
      workspaceTrust: false,
      phases: false,
      retryConditions: false
    };
    const { logger } = buildLogger();
    const projector = makeProjector(logger);
    const trust = readTrust(projector.project());
    expect(trust.workspaceTrust).toBe(false);
    expect(trust.resolvedTrust.phases).toBe(false);
    expect(trust.resolvedTrust.retryConditions).toBe(false);
    projector.dispose();
  });
});

describe('state-projector trust projection (059, T021) — fail-closed on resolver throw', () => {
  it('falls back to all-false defaults and logs a warning when the resolver throws', () => {
    mocks.state.throwOnNext = true;
    const { logger, warnings } = buildLogger();
    const projector = makeProjector(logger);
    const trust = readTrust(projector.project());
    expect(trust.workspaceTrust).toBe(false);
    expect(trust.resolvedTrust.phases).toBe(false);
    expect(trust.resolvedTrust.retryConditions).toBe(false);
    // FR-R3-143 (T036, T037) — the new field falls back WITH the rest, and it
    // falls back to the ceiling rather than to a setting. A disclosure reading
    // `'user'` here would tell an operator their own setting denied something,
    // when in fact the resolver failed and nothing was read at all.
    expect(trust.resolvedScope.phases).toBe('workspace-trust');
    expect(trust.resolvedScope.retryConditions).toBe('workspace-trust');
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some((w) => /trust/i.test(w))).toBe(true);
    projector.dispose();
  });
});

describe('state-projector trust projection (059, T021) — kick() pushes', () => {
  it('re-reads the resolver on each project() call (no internal cache)', () => {
    const { logger } = buildLogger();
    const projector = makeProjector(logger);
    mocks.state.callCount = 0;
    projector.project();
    projector.project();
    projector.project();
    expect(mocks.state.callCount).toBeGreaterThanOrEqual(3);
    projector.dispose();
  });
});
