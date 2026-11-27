// Bug "there is no way to start a pending task" (2026-09-02), first finding — the
// badge that named a queue's lifecycle and called it what the queue was doing.
//
// `QueueLifecycle` has four members and only two of them are unheld:
// `'running'` (unheld, has work) and `'active-empty'` (unheld, nothing to do).
// There is no member for *unheld, has work, nothing executing right now*, which is
// a state a queue reaches legitimately every time a drain declines — at the
// concurrency ceiling, on a lease another window holds, on an admission that
// threw. The lifecycle stays `'running'` because the queue is still one the drain
// may visit. It just is not being visited.
//
// So `queueLifecycleLabel(runtime.lifecycle)` printed `Running` over a queue with
// twenty-one rows pending and nothing running, and the operator asked how to start
// a task that the dashboard was claiming had started.
//
// THE RULE. A badge over a live queue asks `queueRuntimeLabel(runtime)`, which
// asks both questions — may the drain visit it, and is it working a Run — and
// says which it means. `queueLifecycleLabel` still exists, because the lifecycle
// is a real thing a surface may legitimately want named, but nothing that renders
// a queue may reach for it: naming the lifecycle where the operator expects
// activity is the defect, and it is the same defect every time.
//
// This is mechanically decidable, which is why it is a gate rather than a
// paragraph in a report. The undecidable half of the same conflation —
// "presence read as liveness" versus "presence read as ownership" — is recorded
// in `DONE_the-run-that-ended-but-never-stopped-counting.md` as deliberately
// ungated, because telling those apart is a question about intent.

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..');
const WEBVIEW_SRC = resolve(REPO_ROOT, 'webview-ui', 'src');

const LIFECYCLE_LABEL = 'queueLifecycleLabel';
const RUNTIME_LABEL = 'queueRuntimeLabel';

/**
 * The only files allowed to name `queueLifecycleLabel`: the module that declares
 * it, and the suite that pins what it returns. Every entry is checked to still
 * contain the symbol, so a rename cannot leave this list quietly permitting a
 * file that no longer participates.
 */
const ALLOWED = [
  'webview-ui/src/lib/queue-lifecycle-label.ts',
  'webview-ui/src/lib/__tests__/queue-lifecycle-label.test.ts'
] as const;

function collectSources(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectSources(path));
    else if (entry.isFile() && /\.(ts|svelte)$/.test(entry.name)) files.push(path);
  }
  return files;
}

function namesLifecycleLabel(path: string): boolean {
  return readFileSync(path, 'utf8').includes(LIFECYCLE_LABEL);
}

describe('a queue badge reads what the queue is doing, not what it is allowed to do', () => {
  it('confines queueLifecycleLabel to its own module and suite', () => {
    const offenders = collectSources(WEBVIEW_SRC)
      .filter(namesLifecycleLabel)
      .map((path) => relative(REPO_ROOT, path))
      .filter((path) => !ALLOWED.includes(path as (typeof ALLOWED)[number]))
      .sort();

    expect(
      offenders,
      `These files name ${LIFECYCLE_LABEL}, which labels the LIFECYCLE — whether the drain may ` +
        `visit this queue — not whether anything is executing on it. A surface that badges a ` +
        `queue calls ${RUNTIME_LABEL}(runtime) instead, which distinguishes a queue working a ` +
        `Run from one that is unheld and waiting. If this file genuinely needs the lifecycle's ` +
        `own name, add it to ALLOWED here and say why.`
    ).toEqual([]);
  });

  it('keeps every allowlist entry load-bearing', () => {
    for (const entry of ALLOWED) {
      const source = readFileSync(resolve(REPO_ROOT, entry), 'utf8');
      expect(source, `${entry} no longer names ${LIFECYCLE_LABEL}`).toContain(LIFECYCLE_LABEL);
    }
  });

  it('is not vacuous: the badges it protects exist and use the runtime label', () => {
    // Without this, deleting both drill-down tiers would make the gate above pass
    // for the wrong reason. Components, specifically — a helper module using the
    // runtime label would satisfy a weaker check without a badge existing.
    const badges = collectSources(resolve(WEBVIEW_SRC, 'components'))
      .filter((path) => readFileSync(path, 'utf8').includes(`${RUNTIME_LABEL}(`))
      .map((path) => relative(REPO_ROOT, path));

    expect(badges.length).toBeGreaterThan(0);
  });
});
