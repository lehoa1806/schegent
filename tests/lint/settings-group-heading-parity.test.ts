// FR-R3-143 (T047) — the four General Settings group headings, against the four
// reference-doc headings they are required to reproduce.
//
// FR-006 says the tab presents the four §4 group headings "verbatim", and §4 is
// `docs/reference/settings.md`. Verbatim was asserted and never checked, and one
// of the four had already drifted when this gate was written: the component said
// `Backends and process environment` and the doc said `Backend`. A single letter,
// on the heading an operator uses to decide which page describes the control in
// front of them.
//
// The direction is deliberate: the doc is the source and the component must
// match it. The doc rows are held to the manifest by
// `tests/unit/config/settings-schema-parity.test.ts`, so a heading that tracks
// the doc tracks the contract; a doc edited to match a drifted component would
// break that chain silently.
//
// Text comparison rather than a mounted DOM. A component test would prove the
// heading renders, which was never in doubt — what nothing could say is whether
// the string equals the doc's. Reading both files also means this gate has no
// jsdom cost and lives with the other source-adjudicating checks.
//
// An unparseable file fails. Reporting "all four match" on the strength of zero
// headings found is the tautology this repo has caught in skip paths before, so
// the count is asserted before the contents are.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SETTINGS_DOC = resolve(REPO_ROOT, 'docs', 'reference', 'settings.md');
const GROUP_DIR = resolve(REPO_ROOT, 'webview-ui', 'src', 'components', 'settings', 'general');

/**
 * The four group components, in the order the tab renders them.
 *
 * Hand-listed because the pairing is the claim: this file says "the group
 * `BackendEnvironmentGroup.svelte` renders is the doc section
 * `Backend and process environment`". Deriving both sides from one place would
 * make the test agree with itself.
 */
const GROUPS: readonly { readonly file: string; readonly heading: string }[] = [
  { file: 'BackendEnvironmentGroup.svelte', heading: 'Backend and process environment' },
  { file: 'ExecutionRetryGroup.svelte', heading: 'Execution, queues, and retry' },
  { file: 'AuditLoggingGroup.svelte', heading: 'Audit, transcripts, and runtime logging' },
  { file: 'UiTrustGroup.svelte', heading: 'UI, trust, and Claude-specific behavior' }
];

/** The text of the one `<summary>` in a group component, or `null`. */
function summaryText(source: string): string | null {
  const match = /<summary>([^<]*)<\/summary>/.exec(source);
  return match === null ? null : match[1].trim();
}

/** Every `## ` heading in the reference doc, in document order. */
function documentHeadings(source: string): readonly string[] {
  return [...source.matchAll(/^## (.+)$/gm)].map((match) => match[1].trim());
}

describe('settings group heading parity', () => {
  const docSource = readFileSync(SETTINGS_DOC, 'utf8');
  const headings = documentHeadings(docSource);

  it('locates the reference doc headings', () => {
    expect(
      headings,
      'no `## ` heading was found in docs/reference/settings.md, so every ' +
        'comparison below would pass on nothing'
    ).not.toHaveLength(0);
  });

  it.each(GROUPS)('$file renders the doc heading verbatim', ({ file, heading }) => {
    const rendered = summaryText(readFileSync(resolve(GROUP_DIR, file), 'utf8'));
    expect(rendered, `${file} has no <summary>, so it renders no group heading`).not.toBeNull();
    expect(
      rendered,
      `${file} renders a heading that is not the one docs/reference/settings.md ` +
        'declares; FR-006 requires the two to be identical, and the doc is the source'
    ).toBe(heading);
  });

  it.each(GROUPS)('$heading is a section of the reference doc', ({ heading }) => {
    expect(
      headings,
      'the tab renders a group heading that names no section of ' +
        'docs/reference/settings.md, so an operator following it lands nowhere'
    ).toContain(heading);
  });

  // The four checks above pass on the tree as it stands, which says nothing
  // about whether they can fail. These drive the same parsers with synthetic
  // inputs so each verdict is observed in both directions.
  describe('the gate detects what it claims to', () => {
    it('reads the summary it is pointed at', () => {
      expect(summaryText('<details>\n  <summary>Alpha and beta</summary>\n</details>')).toBe(
        'Alpha and beta'
      );
    });

    it('returns null when there is no summary', () => {
      expect(summaryText('<details>\n  <p>no heading here</p>\n</details>')).toBeNull();
    });

    it('reads only level-two headings, in order', () => {
      expect(documentHeadings('# Title\n\n## One\n\ntext\n\n### Deeper\n\n## Two\n')).toEqual([
        'One',
        'Two'
      ]);
    });
  });
});
