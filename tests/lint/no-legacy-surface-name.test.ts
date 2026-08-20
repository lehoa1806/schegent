// Feature 101 (US8, FR-002) — no surface is labeled "Process Library".
//
// Added during this feature's review, because the rename shipped with one
// survivor and nothing to catch it: `BuilderTabs.svelte` carried
// `aria-label="Process library catalogs"` through the Phase 1 extraction. It was
// missed twice over. A sighted reader never sees an accessible name, so walking
// the surface does not find it; and quickstart.md §8's `rg -n "Process Library"`
// is case-sensitive, so the check that was supposed to find it reported clean on
// a live violation.
//
// Hence: case-insensitive, and no allowlist. FR-002 is about what a *surface* is
// labeled, and an accessible name is a label — the one a screen-reader user is
// read instead of the visible text, not a lesser copy of it.
//
// Scoped to the two source trees rather than the repository. Specs, plans, and
// this file's own docstring must be able to name the old term to record that it
// was retired; a lint that forbade the word everywhere would forbid saying so.
//
// The route id half of the rename (FR-003) needs nothing here:
// `webview-ui/src/dashboard/routes.test.ts` pins `DASHBOARD_ROUTES` to its exact
// seven members, which is strictly stronger than an absence scan.

import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

/** The host surface tree and the webview surface tree. Labels live in both. */
const SCAN_ROOTS: readonly string[] = [
  resolve(REPO_ROOT, 'src'),
  resolve(REPO_ROOT, 'webview-ui', 'src')
];

const LEGACY_NAME = 'Process Library';

function scan(pattern: string): readonly string[] {
  const hits: string[] = [];
  for (const root of SCAN_ROOTS) {
    let out: string;
    try {
      out = execSync(`grep -rin "${pattern}" "${root}"`, { encoding: 'utf8' });
    } catch (err: unknown) {
      // grep exits 1 for "no matches", which is the passing case here.
      const failure = err as { status?: number; stdout?: string };
      if (failure.status === 1 && !failure.stdout?.trim()) continue;
      throw err;
    }
    for (const line of out.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      hits.push(
        trimmed.startsWith(REPO_ROOT + '/') ? trimmed.slice(REPO_ROOT.length + 1) : trimmed
      );
    }
  }
  return hits;
}

describe('Feature 101 FR-002 — the retired surface name appears on no surface', () => {
  it(`no source file says "${LEGACY_NAME}", in any casing`, () => {
    expect(
      scan(LEGACY_NAME),
      `FR-002: no surface may be labeled "${LEGACY_NAME}". The surface is the Builder. `
        + 'This includes accessible names (aria-label, aria-description, title) — they are '
        + 'what a screen-reader user is read in place of the visible label, not a lesser copy of it.'
    ).toEqual([]);
  });

  it('is looking at trees that exist, and would fail if the name came back', () => {
    // A scanner pointed at a missing directory reports clean forever. `Builder`
    // is the name that replaced the old one, so finding it proves both that the
    // roots resolve and that the grep works.
    expect(scan('Builder').length).toBeGreaterThan(0);
  });
});
