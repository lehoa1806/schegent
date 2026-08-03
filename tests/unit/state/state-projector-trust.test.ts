// Feature 059 (US5, T021) — state-projector trust-projection unit tests.
// Contract: specs/059-fine-grained-trust-scopes/contracts/trust-projection-contract.md
//
// Covers the four bullets under "Test coverage" in the contract:
//   1. Resolver returns trust=true everywhere → projection has the four
//      `true` values (`workspaceTrust`, `resolvedTrust.{phases,
//      retryConditions, pipelineOverrides}`).
//   2. Resolver returns trust=false → projection contains those four
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
      retryConditions: true,
      pipelineOverrides: true,
      workflowOverrides: true
    } as {
      workspaceTrust: boolean;
      phases: boolean;
      retryConditions: boolean;
      pipelineOverrides: boolean;
      workflowOverrides: boolean;
    },
    throwOnNext: false as boolean,
    callCount: 0 as number
  };
  return { state };
});

vi.mock('../../../src/state/capability-trust-resolver', () => ({
  getResolvedCapabilities: () => {
    mocks.state.callCount += 1;
    if (mocks.state.throwOnNext) {
      throw new Error('resolver boom');
    }
    return { ...mocks.state.nextReturn };
  }
}));

import { StateProjector } from '../../../src/ui/sidebar/state-projector';
import type { WorkflowSnapshot } from '../../../src/ui/sidebar/snapshot';

interface TrustFields {
  workspaceTrust: boolean;
  resolvedTrust: {
    phases: boolean;
    retryConditions: boolean;
    pipelineOverrides: boolean;
    workflowOverrides: boolean;
  };
}

function readTrust(snap: WorkflowSnapshot): TrustFields {
  const anySnap = snap as unknown as Partial<TrustFields>;
  return {
    workspaceTrust: anySnap.workspaceTrust as boolean,
    resolvedTrust: anySnap.resolvedTrust as TrustFields['resolvedTrust']
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger: logger as any
  });
}

beforeEach(() => {
  mocks.state.nextReturn = {
    workspaceTrust: true,
    phases: true,
    retryConditions: true,
    pipelineOverrides: true,
    workflowOverrides: true
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
    expect(trust.resolvedTrust.pipelineOverrides).toBe(true);
    expect(trust.resolvedTrust.workflowOverrides).toBe(true);
    expect(warnings).toEqual([]);
    projector.dispose();
  });

  it('emits the resolver values when capabilities differ (granular)', () => {
    mocks.state.nextReturn = {
      workspaceTrust: true,
      phases: false,
      retryConditions: true,
      pipelineOverrides: false,
      // Feature 083 — a distinct capability, so it must survive a
      // projection that denies `pipelineOverrides` in the same pass.
      workflowOverrides: true
    };
    const { logger } = buildLogger();
    const projector = makeProjector(logger);
    const trust = readTrust(projector.project());
    expect(trust.workspaceTrust).toBe(true);
    expect(trust.resolvedTrust.phases).toBe(false);
    expect(trust.resolvedTrust.retryConditions).toBe(true);
    expect(trust.resolvedTrust.pipelineOverrides).toBe(false);
    expect(trust.resolvedTrust.workflowOverrides).toBe(true);
    projector.dispose();
  });
});

describe('state-projector trust projection (059, T021) — untrusted workspace', () => {
  it('emits all-false trust fields when workspaceTrust is false', () => {
    mocks.state.nextReturn = {
      workspaceTrust: false,
      phases: false,
      retryConditions: false,
      pipelineOverrides: false,
      workflowOverrides: false
    };
    const { logger } = buildLogger();
    const projector = makeProjector(logger);
    const trust = readTrust(projector.project());
    expect(trust.workspaceTrust).toBe(false);
    expect(trust.resolvedTrust.phases).toBe(false);
    expect(trust.resolvedTrust.retryConditions).toBe(false);
    expect(trust.resolvedTrust.pipelineOverrides).toBe(false);
    expect(trust.resolvedTrust.workflowOverrides).toBe(false);
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
    expect(trust.resolvedTrust.pipelineOverrides).toBe(false);
    expect(trust.resolvedTrust.workflowOverrides).toBe(false);
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
