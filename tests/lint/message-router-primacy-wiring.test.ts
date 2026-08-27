// FR-R3-024 (FR-005, FR-005a) — defense-in-depth lint for the MessageRouter
// primary-window gate, the sibling of `message-router-trust-wiring.test.ts`.
//
// The gate fails closed on an absent `isPrimary` (FR-001), which only holds as a
// convention if tests state their primacy posture instead of inheriting a
// default. Before FR-R3-024 an absent callback returned `true`, so a test that
// omitted it silently exercised the primary path and a host wiring regression
// looked exactly like a granted claim.
//
// The production half pins the predicate, not just its presence: `isPrimary`
// must resolve to `lock.hasPrimacy()`, which awaits the fenced ownership record.
// `lock.isHeld()` reads the per-host `Memento` mirror and is advisory by
// `lock.ts`'s own split, so wiring it here would put a decision on a projection.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { filesMatching } from './source-scan';

const REPO_ROOT = resolve(__dirname, '..', '..');
// FR-R3-119 — the production wiring moved. `new MessageRouter({...})` was 240
// lines inside `wireStage2()` in `src/extension.ts`; it is now
// `src/activation/sidebar-router-wiring.ts`, which is where `src/activation/` is
// the composition root says it should have been. This gate reads the wiring, not
// the entry file, so it follows the construction rather than the filename.
const EXTENSION_PATH = resolve(REPO_ROOT, 'src', 'extension.ts');
const ROUTER_WIRING_PATH = resolve(REPO_ROOT, 'src', 'activation', 'sidebar-router-wiring.ts');

/**
 * Both composition-root sites, read together. The two authoritative reads used to
 * sit in one file; FR-R3-119 moved the sidebar router into `src/activation/` and
 * left the schedule watchdog in the entry file, so the count is across the pair.
 * Counting per-file would let one site vanish while the other doubled.
 */
// FR-R3-119 — the schedule watchdog's authoritative read moved to
// `scheduled-work-wiring.ts` with the watchdog itself. The COUNT is the rule and
// is unchanged at two; the pair of files holding them is not.
const SCHEDULED_WORK_PATH = resolve(REPO_ROOT, 'src', 'activation', 'scheduled-work-wiring.ts');
const WIRING_SOURCES = [EXTENSION_PATH, ROUTER_WIRING_PATH, SCHEDULED_WORK_PATH] as const;
const TEST_ROOT = resolve(REPO_ROOT, 'tests');

/**
 * Empty by design. Every test that constructs a `MessageRouter` already states
 * its primacy posture, so there is nothing to tolerate — which is the point of
 * landing the gate rather than describing it. A genuine read-only router test
 * may be added here with the reason it needs no posture.
 */
const PRIMACY_EXEMPT_ROUTER_TESTS: ReadonlySet<string> = new Set([]);

function rel(abs: string): string {
  return abs.startsWith(REPO_ROOT + '/') ? abs.slice(REPO_ROOT.length + 1) : abs;
}

function listMessageRouterTests(): readonly string[] {
  let out: string;
  try {
    out = filesMatching(TEST_ROOT, "new MessageRouter", { fixed: true }).join('\n');
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string };
    if (e.status === 1 && (!e.stdout || e.stdout.trim() === '')) {
      return [];
    }
    throw err;
  }
  return (
    out
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map(rel)
      // The lint tests themselves match on the constructor name appearing as a
      // `grep` argument, not on a construction. Excluded by directory rather
      // than by an allowlist entry, so this test does not read as tolerating a
      // violation it does not have.
      .filter((file) => !file.startsWith('tests/lint/'))
  );
}

describe('MessageRouter primary-window wiring', () => {
  it('production wiring reads the authoritative predicate, in both places', () => {
    const sources = WIRING_SOURCES.map((path) => readFileSync(path, 'utf8'));
    const authoritative = sources.reduce(
      (total, src) => total + src.split('isPrimary: () => lock.hasPrimacy()').length - 1,
      0
    );
    // Two: the sidebar IPC router (src/activation/sidebar-router-wiring.ts) and
    // the schedule watchdog (src/extension.ts). Both decide whether this window
    // may act on shared workspace state.
    expect(authoritative).toBe(2);
    for (const src of sources) expect(src).not.toContain('isPrimary: () => lock.isHeld()');
  });

  it('every router test states its primacy posture', () => {
    const offenders: string[] = [];
    for (const file of listMessageRouterTests()) {
      if (PRIMACY_EXEMPT_ROUTER_TESTS.has(file)) continue;
      const src = readFileSync(resolve(REPO_ROOT, file), 'utf8');
      if (!src.includes('isPrimary')) {
        offenders.push(file);
      }
    }
    expect(
      offenders,
      `MessageRouter tests must wire isPrimary explicitly (the gate fails closed without it):\n${offenders.join('\n')}`
    ).toEqual([]);
  });

  it('finds router tests to check, so a broken scan cannot pass vacuously', () => {
    expect(listMessageRouterTests().length).toBeGreaterThan(20);
  });
});
