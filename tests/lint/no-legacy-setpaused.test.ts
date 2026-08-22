// Feature 030 BUG-001 T056 (SC-008) — repo-grep regression test enforcing
// the single-writer rule for queue pause state.
//
// After T054 deletes `QueueManager.setPaused`, no production file outside
// `repo/src/queue/queue-manager.ts` may reference the legacy method by
// name, and no production file outside `queue-manager.ts` may write to
// `QueueState.paused` via `setQueue({ ..., paused: ... })`. The single
// writer is `QueueManager.setQueuePausedState`.
//
// Tests in `repo/tests/` are intentionally exempt — fixture seeding may
// continue to use whichever public surface is convenient for the test
// (today, all such fixtures already migrated to `setQueuePausedState`,
// but the lint policy targets production code, not test scaffolding).

import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { filesMatching } from './source-scan';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SCAN_ROOTS = [
  resolve(REPO_ROOT, 'src'),
  resolve(REPO_ROOT, 'webview-ui', 'src')
];

const QUEUE_MANAGER_REL = 'src/queue/queue-manager.ts';

// Files that are LEGITIMATE writers of `QueueState.paused` because they
// own the persistence boundary itself. `workspace-state.ts` implements
// `setQueue` and seeds the initial paused-false default; the
// `queue-state-migrator.ts` performs the v5 → v6 schema migration that
// constructs the initial registry + legacy snapshot in lockstep. The
// single-writer rule applies to RUNTIME mutators, not the storage and
// migration layer.
const PERSISTENCE_ALLOWLIST: ReadonlySet<string> = new Set([
  'src/state/workspace-state.ts',
  'src/state/queue-state-migrator.ts'
]);

function listMatchingFiles(pattern: string, root: string): readonly string[] {
  let out: string;
  try {
    out = filesMatching(root, pattern, { fixed: true }).join('\n');
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string };
    if (e.status === 1 && (!e.stdout || e.stdout.trim() === '')) {
      return [];
    }
    throw err;
  }
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((abs) =>
      abs.startsWith(REPO_ROOT + '/') ? abs.slice(REPO_ROOT.length + 1) : abs
    );
}

function scanAll(pattern: string): readonly string[] {
  return SCAN_ROOTS.flatMap((root) => listMatchingFiles(pattern, root));
}

describe('Feature 030 BUG-001 T056 (SC-008) — no legacy setPaused', () => {
  it('production source has zero references to `QueueManager.setPaused(`', () => {
    // `\.setPaused(` catches method-call syntax (queue.setPaused(...),
    // this.setPaused(...), ops.setPaused(...), etc.). The dot anchors the
    // match so unrelated identifiers that contain the substring are not
    // flagged.
    const matched = scanAll('\\.setPaused(');
    expect(
      matched,
      `Offending files referencing .setPaused(:\n${matched.join('\n')}`
    ).toEqual([]);
  });

  it('production source has zero `setPaused(` definitions', () => {
    // The legacy `setPaused` method body is deleted in T054. A bare
    // `setPaused(` should not appear in any production file (as a method
    // signature, interface member, mock stub, etc.). The single writer is
    // `setQueuePausedState`.
    const matched = scanAll('setPaused(');
    const offenders = matched.filter((rel) => rel !== QUEUE_MANAGER_REL);
    expect(
      offenders,
      `Offending files declaring setPaused(:\n${offenders.join('\n')}`
    ).toEqual([]);
  });

  it('production source outside queue-manager.ts performs no external `paused:` write to QueueState', () => {
    // FR-020 / FR-022 mandate that the legacy `QueueState.paused` boolean
    // is written atomically alongside the registry by
    // `setQueuePausedState` only. This guard catches any drift back to
    // a stray `setQueue({ ..., paused: <expr> })` pattern.
    const matched = scanAll('paused:');
    const offenders = matched
      .filter((rel) => rel !== QUEUE_MANAGER_REL)
      .filter((rel) => !PERSISTENCE_ALLOWLIST.has(rel))
      .filter((rel) => {
        // Filter further to only flag files that combine `setQueue(` with
        // a `paused:` literal — i.e., the write pattern. Reads of
        // `queue.paused`, type declarations, and unrelated fields don't
        // match this combined pattern.
        let out: string;
        try {
          out = filesMatching(resolve(REPO_ROOT, rel), "setQueue(", { fixed: true }).join('\n');
        } catch {
          return false;
        }
        return out.trim().length > 0;
      });
    expect(
      offenders,
      `Files combining setQueue( + paused: write outside queue-manager.ts:\n${offenders.join('\n')}`
    ).toEqual([]);
  });
});
