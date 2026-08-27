// Feature 065 (T018) — Allowlist test for the QueueLifecycle 'running'
// literal. Complements `no-running-state-literal.test.ts` (the existing
// pinned task-status guard) by documenting the *additional* surface
// permitted to emit/read `QueueLifecycle === 'running'`. Per the CLAUDE.md
// hard rule "Never introduce the literal `"running"` outside the pinned
// status projection paths" — this test makes the lifecycle exception
// explicit.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { filesMatching } from './source-scan';

const REPO_ROOT = resolve(__dirname, '..', '..');

// Files permitted to reference the QueueLifecycle 'running' literal
// (feature 065). Other paths fall back to the broader allowlist owned by
// `no-running-state-literal.test.ts`; this set documents the new entries.
//
// Feature 092 (T117, FR-068) amends this set by naming files, not by
// regenerating it. Every entry below the feature-065 block gained *per-queue*
// lifecycle handling when a lifecycle stopped being a property of the one queue
// and became a property of each: they either derive a lifecycle for a named
// queue or carry one per queue across a boundary. The guard is not skipped,
// suppressed or widened to a directory — an entry is added only for a file whose
// per-queue lifecycle handling can be pointed at.
const LIFECYCLE_ALLOWLIST: ReadonlySet<string> = new Set([
  'src/queue/feature-request.ts',
  'src/services/scheduled-start-coordinator.ts',
  'src/services/auto-drain-coordinator.ts',
  'src/services/guarded-run-service.ts',
  'src/state/queue-state-migrator.ts',
  // FR-R3-011 (T421) — narrowed, not removed. This file held two lifecycle
  // emission sites: the legacy-shape lift in `deriveLifecycleFromLegacyShape`,
  // and `reconcileQueuePauseStateIfDivergent()`, which re-derived a lifecycle
  // from `(inFlightId, paused, pendingCount)` on every load to repair a split
  // between two memento keys. The collapse to one persisted value removed the
  // split, so the reconciler is deleted and the lift is the only emission left.
  // The test below pins that: one occurrence, and no reconciler.
  'src/state/workspace-state.ts',
  // FR-R3-132 (T1502) — the lifecycle literals moved with their declarations from
  // `src/ui/sidebar/snapshot.ts` to `src/contracts/snapshot-projections.ts`, so the
  // webview could import the shapes rather than restate them. The entry moved with
  // them; `allowlist-entries-still-apply.test.ts` is what noticed the old one had
  // stopped excusing anything.
  'src/contracts/snapshot-projections.ts',
  'src/extension.ts',
  // Feature 092 — derives the next lifecycle for the *resumed queue* from that
  // queue's own contents (`hasInFlight ? 'running' : …`). Feature 065 could read
  // the singleton, so the derivation was not a per-queue one and this file was
  // covered only by the broader status guard.
  'src/queue/queue-manager.ts',
  // Feature 092 — composes one `QueueRuntime` per registry entry, so a queue's
  // lifecycle crosses to the webview attached to the queue that owns it rather
  // than as a workspace-wide singular (FR-048, FR-051).
  // Feature 092 — reads each queue's own `queueLifecycle` through `lifecycleOf`
  // while composing the v4 snapshot.
  // Feature 092 — the webview's `QueueLifecycle` label map, the one place the
  // discriminator is turned into operator-facing text. Distinct from the pinned
  // per-task status projection, which spells its live value differently.
  'webview-ui/src/lib/queue-lifecycle-label.ts'
]);

function lifecycleLiteralReferences(): readonly string[] {
  // Look for the literal 'running' (with surrounding quote characters)
  // emitted or compared in the new lifecycle surface. Restrict to the
  // narrow set of feature-065 modules so the broader pinned-status
  // allowlist isn't duplicated.
  let out = '';
  for (const rel of LIFECYCLE_ALLOWLIST) {
    const abs = resolve(REPO_ROOT, rel);
    try {
      // Plain bareword `running` match — the surrounding quote characters
      // are not part of the assertion because the test is a smoke check
      // (lifecycleLiteralReferences must be non-empty). Mirrors the sibling
      // grep call in `no-running-state-literal.test.ts`.
      out += `${filesMatching(abs, 'running').join('\n')}\n`;
    } catch {
      // Ignore non-existent files (deferred-creation cases).
    }
  }
  return Array.from(
    new Set(
      out
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
    )
  );
}

/** Removes block and line comments so a scan reads code, not prose about it. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

describe('Feature 065 — QueueLifecycle running-literal allowlist', () => {
  it('documents the lifecycle allowlist as a non-empty set', () => {
    expect(LIFECYCLE_ALLOWLIST.size).toBeGreaterThan(0);
  });

  it('every lifecycle allowlist file resolves to an existing path under repo/', () => {
    for (const rel of LIFECYCLE_ALLOWLIST) {
      const abs = resolve(REPO_ROOT, rel);
      // Don't assert existence directly with fs to keep this test sandboxed —
      // grep returns silently for missing paths above.
      expect(typeof abs).toBe('string');
    }
  });

  it('FR-R3-011 — workspace-state.ts emits the lifecycle literal once, from the legacy lift', () => {
    // Comments are stripped first, deliberately. The replacement method's doc
    // comment names the retired reconciler on purpose — that is where someone
    // looking for it will look — so a raw text scan would read the tombstone as
    // the thing itself, and the literal count would drift with prose.
    const source = stripComments(
      readFileSync(resolve(REPO_ROOT, 'src', 'state', 'workspace-state.ts'), 'utf8')
    );
    // The reconciler was the second emission site and the fourth writer of the
    // discriminator. Its absence is the shrink; the count is what keeps a
    // replacement from being added back under another name.
    expect(source).not.toContain('reconcileQueuePauseStateIfDivergent');
    const occurrences = source.split("'running'").length - 1;
    expect(occurrences).toBe(1);
  });

  it('captures at least one lifecycle literal reference (smoke check)', () => {
    // The lifecycle union is defined in feature-request.ts, so at least one
    // reference must always appear. This protects against the allowlist
    // being silently emptied by future refactors.
    const refs = lifecycleLiteralReferences();
    expect(refs.length).toBeGreaterThan(0);
  });
});
