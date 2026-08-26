// FR-R3-091 — the policy statement, the scan's target, and the baseline are one
// claim, checked from all three ends.
//
// THE CLASS. `A11Y-01` is the only Medium-CONFIDENCE row in its register, and
// the confidence is honest: the review did not establish a failure, it
// established that nobody had looked. What it did establish is that the product
// carries a WCAG policy statement and nothing scanned against it — "a policy
// statement with no scan is the R-14 class", operator-facing text asserting a
// property nothing checks. That class was closed three times in this round.
//
// THE STATEMENTS EXIST IN THE PLANNING ENVELOPE, so this gate reaches across the
// repository boundary — deliberately, and it degrades rather than fails when the
// envelope is absent, because `repo/` is cloned standalone by CI. A gate that
// hard-failed in a repo-only clone would be a gate someone deletes.
//
// WHAT IS PINNED
//   1. the scan's configured axe tag set IS WCAG 2.1 AA and nothing wider;
//   2. the baseline states the same target it was measured against;
//   3. both policy statements name that same level, so the restored statement
//      cannot drift back into an unbacked claim;
//   4. the a11y harness and the visual suite agree on the boot contract — the
//      theme class names and the snapshot message shape — since the two suites
//      set up the same app and a silent divergence would mean the scan measured
//      a page the product never renders.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..');
const ENVELOPE_ROOT = resolve(REPO_ROOT, '..');
const TARGET = 'WCAG 2.1 Level AA';

const read = (absolute: string): string => readFileSync(absolute, 'utf8');
const spec = read(resolve(REPO_ROOT, 'tests/a11y/a11y-scan.spec.ts'));
const harness = read(resolve(REPO_ROOT, 'tests/a11y/a11y-harness.ts'));
const visual = read(resolve(REPO_ROOT, 'tests/visual/webview.visual.spec.ts'));
const baseline = JSON.parse(read(resolve(REPO_ROOT, 'tests/a11y/a11y-baseline.json'))) as {
  target: string;
  accepted: ReadonlyArray<{ route: string; theme: string; ruleId: string; selector: string }>;
};

/** The envelope statements, when the envelope is present. */
const ENVELOPE_STATEMENTS = ['PRODUCT.md', 'docs/prd-metrics-dashboard.md'] as const;

describe('FR-R3-091 — the conformance target is one claim, not three', () => {
  it('the scan is configured against WCAG 2.1 AA, and nothing wider', () => {
    // A tag set that quietly included `best-practice` would report findings the
    // product never claimed to meet; one missing `wcag21aa` would silently drop
    // the half that distinguishes 2.1 from 2.0.
    expect(spec).toContain("'wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'");
    expect(spec).not.toContain('best-practice');
    expect(spec).not.toContain('wcag2aaa');
    expect(spec).not.toContain('wcag21aaa');
  });

  it('the baseline states the target it was measured against', () => {
    expect(baseline.target).toBe(TARGET);
    // A baseline is a count AND a list. An entry missing either half is a record
    // that can say something got worse without saying which.
    for (const finding of baseline.accepted) {
      expect(finding.route.length).toBeGreaterThan(0);
      expect(finding.theme.length).toBeGreaterThan(0);
      expect(finding.ruleId.length).toBeGreaterThan(0);
      expect(finding.selector.length).toBeGreaterThan(0);
    }
  });

  it('the scan states that an automated scan is not conformance', () => {
    // Required wherever the result is reported. Without it, a green gate reads
    // as conformance — the false assurance the eval corpus was before FR-R3-061.
    expect(spec).toContain('AN AUTOMATED SCAN IS NOT CONFORMANCE');
    expect(read(resolve(REPO_ROOT, 'tests/a11y/README.md'))).toContain(
      'An automated scan is not conformance'
    );
  });

  it('the exclusion list is printed on every run, including when it is empty', () => {
    expect(spec).toContain('excluded routes');
    expect(spec).toContain("'(none)'");
  });

  it('the a11y harness and the visual suite agree on the boot contract', () => {
    // The two suites set up the same app. If they drifted, the scan would be
    // measuring a page the product never renders — and nothing would say so.
    for (const themeClass of ['vscode-light', 'vscode-dark', 'vscode-high-contrast']) {
      expect(harness, `harness must set ${themeClass}`).toContain(themeClass);
      expect(visual, `visual suite must set ${themeClass}`).toContain(themeClass);
    }
    expect(harness).toContain("type: 'STATE_SNAPSHOT'");
    expect(visual).toContain("type: 'STATE_SNAPSHOT'");
    // ...and both draw the same fixture, so neither scans a shape the other
    // never sees.
    expect(harness).toContain('workflowSnapshot');
    expect(visual).toContain('workflowSnapshot');
  });

  it('one server, not two: the a11y config starts the visual suite\'s own script', () => {
    const config = read(resolve(REPO_ROOT, 'playwright.a11y.config.ts'));
    expect(config).toContain('tests/visual/serve-built-webviews.mjs');
    expect(config).toContain('port: 4173');
  });

  it.each(ENVELOPE_STATEMENTS)(
    '%s names the same conformance level the scan targets',
    (relative) => {
      const absolute = resolve(ENVELOPE_ROOT, relative);
      if (!existsSync(absolute)) {
        // A repo-only clone. Degrade rather than fail: this gate must not make a
        // standalone checkout red for a document that is not part of it.
        expect(existsSync(absolute)).toBe(false);
        return;
      }
      const body = read(absolute);
      expect(
        /WCAG\s*2\.1\s*(Level\s*)?AA/i.test(body),
        `${relative} must name WCAG 2.1 AA — the level the scan is configured against. ` +
          `A statement at a different level, or an unversioned one, is a third authority ` +
          `on one subject.`
      ).toBe(true);
      expect(
        /WCAG\s*2\.2|WCAG\s*AAA/i.test(body),
        `${relative} names a level the scan does not measure`
      ).toBe(false);
    }
  );

  it('NON-VACUITY: a drifted statement and a widened tag set are both detected', () => {
    const drifted = 'Ensure high contrast for dense data (WCAG 2.2 Level AA).';
    expect(/WCAG\s*2\.2/i.test(drifted)).toBe(true);
    const widened = spec.replace("'wcag21aa'", "'wcag21aa', 'best-practice'");
    expect(widened).not.toBe(spec);
    expect(widened.includes('best-practice')).toBe(true);
  });
});

/**
 * FR-064's second clause — "Do not weaken existing controls to pass a scan."
 *
 * The temptation is real and specific: a focus trap that a scanner dislikes and
 * a user needs is exactly the kind of thing that gets removed to turn a gate
 * green. So the controls the security review CREDITS — focus trap, ARIA
 * attributes, keyboard handling, reduced-motion support — are asserted present
 * rather than assumed untouched.
 *
 * This is a presence check, not a correctness one, and says so: it catches
 * deletion, which is the failure mode this clause is about.
 */
describe('FR-R3-091 — the credited accessibility controls are not weakened', () => {
  const WEBVIEW_SRC = resolve(REPO_ROOT, 'webview-ui/src');

  const sources = (() => {
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
        const full = resolve(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(svelte|ts)$/.test(entry.name)) out.push(readFileSync(full, 'utf8'));
      }
    };
    walk(WEBVIEW_SRC);
    return out;
  })();

  const countMatching = (pattern: RegExp): number =>
    sources.filter((source) => pattern.test(source)).length;

  it('scanned a non-empty webview tree', () => {
    expect(sources.length).toBeGreaterThan(80);
  });

  it('the focus trap is still present', () => {
    // Named explicitly because it is the control FR-R3-091 §5 uses as its
    // example of one a scanner might dislike and a user needs.
    expect(countMatching(/focus[-_]?trap|trapFocus|FocusTrap/i)).toBeGreaterThan(0);
  });

  it('ARIA attributes are still used across the surfaces', () => {
    expect(countMatching(/aria-[a-z]+=/)).toBeGreaterThan(20);
    expect(countMatching(/role="/)).toBeGreaterThan(5);
  });

  it('keyboard handling is still present', () => {
    expect(countMatching(/on:keydown|onkeydown|KeyboardEvent/)).toBeGreaterThan(3);
  });

  it('reduced-motion support is still present', () => {
    expect(countMatching(/prefers-reduced-motion/)).toBeGreaterThan(0);
  });

  it('no scan-driven suppression appeared in the source', () => {
    // The other way to "pass" a scan: annotate the offending element instead of
    // fixing or accepting it. The baseline is where an accepted finding belongs
    // — visible, listed, and ratcheting — not an inline marker nobody re-reads.
    const suppressed = sources.filter((source) =>
      /data-axe-ignore|axe-exclude|aria-hidden="true"\s*data-testid/.test(source)
    );
    expect(suppressed).toEqual([]);
  });
});
