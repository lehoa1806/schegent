// Feature 059 (US5, T023) — integration test for the trust webview
// projection.
// Contract: specs/059-fine-grained-trust-scopes/contracts/trust-projection-contract.md
//
// Drives the host-side projection pipeline end-to-end:
//   capability-trust-resolver.getResolvedCapabilities() →
//   StateProjector.project() → subscriber receives WorkflowSnapshot with
//   `workspaceTrust` + `resolvedTrust.{phases, retryConditions}`.
//
// Feature 099 (T492, T496f, FR-046) — `pipelineOverrides` (and its Workflow
// twin) went with the layer tier they guarded: they asked whether one layer
// could redefine what another declares, and one layer poses no such question.
// Every claim below is about the surviving pair; the initial-snapshot case
// pins the deleted field as an absence so it cannot return by accident.
//
// This complements the unit test at tests/unit/state/state-projector-trust.test.ts
// by exercising the SUBSCRIBE path (not just `.project()`) and by
// verifying that a kick() / re-publish carries the new resolver value
// (push-not-poll per I-2).

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const state = {
    current: {
      workspaceTrust: true,
      phases: true,
      retryConditions: true
    } as {
      workspaceTrust: boolean;
      phases: boolean;
      retryConditions: boolean;
    },
    throwOnNext: false as boolean
  };
  return { state };
});

vi.mock('../../src/state/capability-trust-resolver', () => ({
  getResolvedCapabilities: () => {
    if (mocks.state.throwOnNext) throw new Error('resolver boom');
    return { ...mocks.state.current };
  }
}));

import { StateProjector } from '../../src/ui/sidebar/state-projector';
import type { WorkflowSnapshot } from '../../src/ui/sidebar/snapshot';

interface TrustView {
  workspaceTrust: boolean;
  resolvedTrust: {
    phases: boolean;
    retryConditions: boolean;
  };
}

function readTrust(snap: WorkflowSnapshot): TrustView {
  const anySnap = snap as unknown as Partial<TrustView>;
  return {
    workspaceTrust: anySnap.workspaceTrust as boolean,
    resolvedTrust: anySnap.resolvedTrust as TrustView['resolvedTrust']
  };
}

function buildProjector(): {
  projector: StateProjector;
  warnings: string[];
  flush: () => Promise<void>;
} {
  const warnings: string[] = [];
  const logger = {
    info: vi.fn(),
    warn: (msg: string) => warnings.push(msg),
    error: vi.fn(),
    debug: vi.fn(),
    sanitize: (s: string) => s
  };
  const projector = new StateProjector({
    ownerId: 'trust-integ-owner',
    debounceMs: 0,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger: logger as any
  });
  const flush = async (): Promise<void> => {
    await new Promise((r) => setTimeout(r, 5));
  };
  return { projector, warnings, flush };
}

beforeEach(() => {
  mocks.state.current = {
    workspaceTrust: true,
    phases: true,
    retryConditions: true
  };
  mocks.state.throwOnNext = false;
});

describe('Feature 059 T023 — trust projection end-to-end via subscriber', () => {
  it('delivers all-true trust fields on the initial subscribe snapshot', () => {
    const { projector } = buildProjector();
    const seen: WorkflowSnapshot[] = [];
    const sub = projector.subscribe((snap) => seen.push(snap));
    expect(seen.length).toBeGreaterThanOrEqual(1);
    const trust = readTrust(seen[seen.length - 1]);
    expect(trust.workspaceTrust).toBe(true);
    expect(trust.resolvedTrust.phases).toBe(true);
    expect(trust.resolvedTrust.retryConditions).toBe(true);
    expect(trust.resolvedTrust).not.toHaveProperty('pipelineOverrides');
    expect(trust.resolvedTrust).not.toHaveProperty('workflowOverrides');
    sub.dispose();
    projector.dispose();
  });

  it('re-publishes with new resolver values after a config-change kick (FR-011, push-not-poll)', async () => {
    const { projector, flush } = buildProjector();
    projector.start();
    const seen: WorkflowSnapshot[] = [];
    const sub = projector.subscribe((snap) => seen.push(snap));
    await flush();

    // Simulate: workspace-scope `schegent.trust.allowCustomPhases: false`
    // arrives via onDidChangeConfiguration → resolver.onProjectionInvalidated
    // → projector.kick().
    mocks.state.current = {
      workspaceTrust: true,
      phases: false,
      retryConditions: true
    };
    projector.kick();
    await flush();

    const last = readTrust(seen[seen.length - 1]);
    expect(last.workspaceTrust).toBe(true);
    expect(last.resolvedTrust.phases).toBe(false);
    expect(last.resolvedTrust.retryConditions).toBe(true);

    // Flip back to allow → next kick re-enables.
    mocks.state.current = {
      workspaceTrust: true,
      phases: true,
      retryConditions: true
    };
    projector.kick();
    await flush();
    const afterReenable = readTrust(seen[seen.length - 1]);
    expect(afterReenable.resolvedTrust.phases).toBe(true);

    sub.dispose();
    projector.dispose();
  });

  it('propagates the untrusted-workspace ceiling: all trust fields false', () => {
    mocks.state.current = {
      workspaceTrust: false,
      phases: false,
      retryConditions: false
    };
    const { projector } = buildProjector();
    const seen: WorkflowSnapshot[] = [];
    const sub = projector.subscribe((snap) => seen.push(snap));
    const trust = readTrust(seen[seen.length - 1]);
    expect(trust.workspaceTrust).toBe(false);
    expect(trust.resolvedTrust.phases).toBe(false);
    expect(trust.resolvedTrust.retryConditions).toBe(false);
    sub.dispose();
    projector.dispose();
  });

  it('fails closed and warns when the resolver throws during projection', () => {
    mocks.state.throwOnNext = true;
    const { projector, warnings } = buildProjector();
    const seen: WorkflowSnapshot[] = [];
    const sub = projector.subscribe((snap) => seen.push(snap));
    const trust = readTrust(seen[seen.length - 1]);
    expect(trust.workspaceTrust).toBe(false);
    expect(trust.resolvedTrust.phases).toBe(false);
    expect(trust.resolvedTrust.retryConditions).toBe(false);
    expect(warnings.length).toBeGreaterThan(0);
    sub.dispose();
    projector.dispose();
  });
});
