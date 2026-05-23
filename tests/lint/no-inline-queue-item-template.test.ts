// Feature 065 BUG-009 / T079 (FR-024) — single render-path lint pin.
//
// The shared `<QueueItem>` component is the SOLE renderer for queue-row
// markup across every webview surface (sidebar `QueueListView`, dashboard
// "Active Queue" panel, etc.). Inline `<li class="item status-...">`
// templates outside `QueueItem.svelte` cause the regressions catalogued in
// `docs/features/066_queue_ui_layout_bugs.md` (FR-024 surface-disparity):
//
//   1. The dashboard panel skips the meta-chip row introduced by
//      `QueueItem` (phase / retry / paused-cause / paused-badge).
//   2. The dashboard panel skips the row-3 / row-footer split, so the
//      action cluster collapses at narrow widths (BUG-005).
//   3. New affordances (per-row Retry on paused, T080) ship to one
//      surface but not the other.
//
// This test fails if any `*.svelte` file outside the allowlist contains
// an inline `<li ... class="item status-..." ...>` element. The match is
// intentionally conservative — we look for the literal `class="item ` and
// a `status-` substring in the same opening tag block, which the inline
// template at `QueueListView.svelte` (before T079) carried verbatim.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SCAN_ROOT = resolve(REPO_ROOT, 'webview-ui', 'src');

// Only the shared component is allowed to declare the canonical row
// template. Tests that scaffold the same `<li class="item status-..">`
// markup for assertion fixtures may be added here on a case-by-case basis.
const ALLOWED_FILES: ReadonlySet<string> = new Set([
  'webview-ui/src/components/QueueItem.svelte'
]);

const ROW_TEMPLATE_SIGNATURE = /class="item status-/;

function listSvelteFiles(dir: string): readonly string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const abs = resolve(dir, name);
    const stat = statSync(abs);
    if (stat.isDirectory()) {
      out.push(...listSvelteFiles(abs));
    } else if (stat.isFile() && abs.endsWith('.svelte')) {
      out.push(abs);
    }
  }
  return out;
}

function listFilesMatching(re: RegExp): readonly string[] {
  return listSvelteFiles(SCAN_ROOT)
    .filter((abs) => re.test(readFileSync(abs, 'utf8')))
    .map((abs) => relative(REPO_ROOT, abs));
}

describe('Feature 065 BUG-009 T079 — single-render-path queue row template', () => {
  it('only QueueItem.svelte renders the canonical `<li class="item ...">` template', () => {
    // The opening tag is multi-line in QueueItem.svelte (`<li\n  class="item status-{item.status} ..."`),
    // so we scan for the `class="item status-` substring; this is the
    // unique signature of the row template that drove BUG-009 issue 4.
    const matched = listFilesMatching(ROW_TEMPLATE_SIGNATURE);
    const offenders = matched.filter((rel) => !ALLOWED_FILES.has(rel));
    expect(
      offenders,
      `Offending svelte files with inline queue-row <li> template:\n${offenders.join('\n')}\n\nPer FR-024, queue rows MUST render via <QueueItem /> (the shared component). Replace the inline template with <QueueItemComponent {item} isSelected={...} onSelect={...} />.`
    ).toEqual([]);
  });

  it('the shared QueueItem.svelte still declares the canonical row template', () => {
    // Negative-control: guarantee the lint pin doesn't accidentally pass
    // because the template was removed from QueueItem.svelte too.
    const matched = listFilesMatching(ROW_TEMPLATE_SIGNATURE);
    expect(matched).toContain('webview-ui/src/components/QueueItem.svelte');
  });

  it('QueueListView.svelte uses <QueueItemComponent /> rather than inline `<li>`', () => {
    // FR-024 regression: BUG-009 issue 4 was a hardcoded inline `<li>`
    // template in QueueListView.svelte. After T079 the component MUST
    // delegate to the shared `<QueueItemComponent>` so all surfaces share
    // the same row markup.
    const src = readFileSync(
      resolve(SCAN_ROOT, 'components', 'QueueListView.svelte'),
      'utf8'
    );
    expect(src).toMatch(/<QueueItemComponent\b/);
    expect(src).not.toMatch(ROW_TEMPLATE_SIGNATURE);
  });
});
