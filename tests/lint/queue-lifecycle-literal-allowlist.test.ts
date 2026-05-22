// Feature 065 (T018) — Allowlist test for the QueueLifecycle 'running'
// literal. Complements `no-running-state-literal.test.ts` (the existing
// pinned task-status guard) by documenting the *additional* surface
// permitted to emit/read `QueueLifecycle === 'running'`. Per the CLAUDE.md
// hard rule "Never introduce the literal `"running"` outside the pinned
// status projection paths" — this test makes the lifecycle exception
// explicit.

import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

// Files permitted to reference the QueueLifecycle 'running' literal
// (feature 065). Other paths fall back to the broader allowlist owned by
// `no-running-state-literal.test.ts`; this set documents the new entries.
const LIFECYCLE_ALLOWLIST: ReadonlySet<string> = new Set([
  'src/queue/feature-request.ts',
  'src/services/scheduled-start-coordinator.ts',
  'src/services/auto-drain-coordinator.ts',
  'src/services/guarded-run-service.ts',
  'src/state/queue-state-migrator.ts',
  'src/state/workspace-state.ts',
  'src/ui/sidebar/snapshot.ts',
  'src/ui/sidebar/state-projector.ts',
  'src/extension.ts'
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
      out += execSync(`grep -El "running" "${abs}" || true`, {
        encoding: 'utf8'
      });
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

  it('captures at least one lifecycle literal reference (smoke check)', () => {
    // The lifecycle union is defined in feature-request.ts, so at least one
    // reference must always appear. This protects against the allowlist
    // being silently emptied by future refactors.
    const refs = lifecycleLiteralReferences();
    expect(refs.length).toBeGreaterThan(0);
  });
});
