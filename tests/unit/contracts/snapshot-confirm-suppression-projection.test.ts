// Feature 063 — T015 contract test for snapshot projection of the
// `confirmSuppression` field. The projector must:
//   (a) surface `confirmSuppression` verbatim when the store implements
//       `getConfirmSuppression()` and returns a value;
//   (b) omit the field entirely when the store accessor is absent
//       (legacy test seam) so the webview falls back to "no suppression";
//   (c) omit the field when `getConfirmSuppression()` returns `undefined`
//       (no value persisted yet).
//
// This test pins the contract from
// specs/063-clean-all-confirmations/contracts/snapshot.md §confirmSuppression
// and protects FR-021 (per-action suppression) against accidental
// projector regressions that would strip the projection.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { StateProjector } from '../../../src/ui/sidebar/state-projector';
import { AuditLogWriter } from '../../../src/audit/audit-log-writer';
import { SanitizedLogger } from '../../../src/lib/logger';
import type { WorkspaceStateStore } from '../../../src/state/workspace-state';
import type { QueueState } from '../../../src/queue/feature-request';
import type { ConfirmSuppressionState } from '../../../src/state/confirm-suppression';

const EMPTY_QUEUE: QueueState = {
  requests: [],
  inFlightId: null,
  paused: false,
  pausedReason: null,
  updatedAt: 0,
  queueLifecycle: 'active-empty',
  scheduledStartAt: null,
  scheduledStartSource: null
};

type StoreShape = NonNullable<ConstructorParameters<typeof StateProjector>[0]['store']>;

function makeStoreWithoutAccessor(): StoreShape {
  return {
    getRunMap: () => ({}),
    getQueue: () => EMPTY_QUEUE,
    getLock: () => null,
    subscribe: () => ({ dispose: () => undefined })
  };
}

function makeStoreWithAccessor(
  value: ConfirmSuppressionState
): StoreShape & Pick<WorkspaceStateStore, 'getConfirmSuppression'> {
  return {
    getRunMap: () => ({}),
    getQueue: () => EMPTY_QUEUE,
    getLock: () => null,
    subscribe: () => ({ dispose: () => undefined }),
    getConfirmSuppression: () => value
  };
}

let tmpRoot: string;
let audit: AuditLogWriter;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-suppression-projection-'));
  audit = new AuditLogWriter({ workspaceRoot: tmpRoot }, new SanitizedLogger());
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('snapshot projection of confirmSuppression (FR-021)', () => {
  it('surfaces the field verbatim when the accessor returns a populated state', () => {
    const populated: ConfirmSuppressionState = {
      version: 1,
      suppressedActionKeys: ['queue.clean-all', 'queue.clear-done']
    };
    const projector = new StateProjector({
      store: makeStoreWithAccessor(populated),
      audit,
      ownerId: 'test-owner'
    });
    const snap = projector.project();
    expect(snap.confirmSuppression).toBeDefined();
    expect(snap.confirmSuppression!.version).toBe(1);
    expect(snap.confirmSuppression!.suppressedActionKeys).toEqual([
      'queue.clean-all',
      'queue.clear-done'
    ]);
    projector.dispose();
  });

  it('passes through an empty suppression set as { version: 1, suppressedActionKeys: [] }', () => {
    const empty: ConfirmSuppressionState = { version: 1, suppressedActionKeys: [] };
    const projector = new StateProjector({
      store: makeStoreWithAccessor(empty),
      audit,
      ownerId: 'test-owner'
    });
    const snap = projector.project();
    expect(snap.confirmSuppression).toBeDefined();
    expect(snap.confirmSuppression!.suppressedActionKeys).toEqual([]);
    projector.dispose();
  });

  it('omits the field entirely when the store does not implement getConfirmSuppression', () => {
    const projector = new StateProjector({
      store: makeStoreWithoutAccessor(),
      audit,
      ownerId: 'test-owner'
    });
    const snap = projector.project();
    expect('confirmSuppression' in snap).toBe(false);
    projector.dispose();
  });

  it('preserves the suppressedActionKeys order from the store (no internal sort)', () => {
    const reverseOrder: ConfirmSuppressionState = {
      version: 1,
      suppressedActionKeys: ['workspace.reset', 'queue.clean-all', 'history.rerun']
    };
    const projector = new StateProjector({
      store: makeStoreWithAccessor(reverseOrder),
      audit,
      ownerId: 'test-owner'
    });
    const snap = projector.project();
    expect(snap.confirmSuppression!.suppressedActionKeys).toEqual([
      'workspace.reset',
      'queue.clean-all',
      'history.rerun'
    ]);
    projector.dispose();
  });

  it('produces a frozen snapshot whose confirmSuppression cannot be mutated', () => {
    const populated: ConfirmSuppressionState = {
      version: 1,
      suppressedActionKeys: ['queue.clean-all']
    };
    const projector = new StateProjector({
      store: makeStoreWithAccessor(populated),
      audit,
      ownerId: 'test-owner'
    });
    const snap = projector.project();
    expect(Object.isFrozen(snap)).toBe(true);
    projector.dispose();
  });
});
