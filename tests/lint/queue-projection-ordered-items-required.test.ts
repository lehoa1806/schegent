// Feature 065 BUG-009 / T077 (FR-029) — pin the `QueueProjection.orderedItems`
// contract as a required field on both sides of the IPC boundary:
//
//   host:    repo/src/ui/sidebar/snapshot.ts  ──► QueueProjection
//   webview: repo/webview-ui/src/lib/snapshot-types.ts ──► QueueProjection
//
// Both type declarations MUST keep `orderedItems` as a non-optional,
// `readonly QueueItem[]` field so the dashboard's "Active Queue" panel
// and the sidebar `QueueListView` always render queue rows from a single
// authoritative flat projection (no legacy `inFlight`/`pending`/`recent`
// bucket math). Marking the field optional would let stale snapshot mocks
// silently re-introduce the "task disappears on cancel" regression from
// `docs/features/round_1/066_queue_ui_layout_bugs.md`.
//
// This test mirrors the established repo-grep pattern used by
// `no-inline-reorder-ipc.test.ts` etc.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

const HOST_SNAPSHOT = resolve(REPO_ROOT, 'src/ui/sidebar/snapshot.ts');
const WEBVIEW_SNAPSHOT_TYPES = resolve(
  REPO_ROOT,
  'webview-ui/src/lib/snapshot-types.ts'
);

describe('Feature 065 BUG-009 T077 — QueueProjection.orderedItems contract', () => {
  it('host `QueueProjection` declares `orderedItems` as a required readonly field', () => {
    const src = readFileSync(HOST_SNAPSHOT, 'utf8');
    // Look for the canonical declaration form. The pin is intentionally
    // strict: a future patch that drops `readonly` or adds `?` will fail
    // this assertion and force a deliberate review of the FR-029 contract.
    expect(src).toMatch(
      /readonly\s+orderedItems\s*:\s*readonly\s+QueueItem\[\]\s*;/
    );
  });

  it('webview `QueueProjection` declares `orderedItems` as a required readonly field', () => {
    const src = readFileSync(WEBVIEW_SNAPSHOT_TYPES, 'utf8');
    expect(src).toMatch(
      /readonly\s+orderedItems\s*:\s*readonly\s+QueueItem\[\]\s*;/
    );
  });

  it('host `QueueProjection` does not mark `orderedItems` optional', () => {
    const src = readFileSync(HOST_SNAPSHOT, 'utf8');
    expect(src).not.toMatch(/orderedItems\s*\?\s*:/);
  });

  it('webview `QueueProjection` does not mark `orderedItems` optional', () => {
    const src = readFileSync(WEBVIEW_SNAPSHOT_TYPES, 'utf8');
    expect(src).not.toMatch(/orderedItems\s*\?\s*:/);
  });
});
