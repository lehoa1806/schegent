// FR-R3-091 — the whole-app accessibility scan.
//
// TARGET: **WCAG 2.1 Level AA**, over every shipped dashboard route in every
// shipped theme. Seven routes x three themes = 21 combinations. The level is not
// chosen here; the product already claims AA in `PRODUCT.md` and 2.1 AA in
// `docs/prd-metrics-dashboard.md`, and `tests/lint/a11y-policy-parity.test.ts`
// binds all three so the restored policy statement cannot drift back into an
// unbacked claim.
//
// AN AUTOMATED SCAN IS NOT CONFORMANCE. Automated tooling catches a minority of
// real barriers. This finds what a rule engine can see in a rendered tree; it
// says nothing about whether a screen-reader user can complete a task. That is
// what `docs/release/accessibility-at-matrix.md` is for. Reading a green scan as
// conformance would make it the same false assurance the eval corpus was before
// FR-R3-061 wrote its scope note — which is why the statement is printed with
// every result rather than left in a README.
//
// A BASELINE, NOT A WALL. Existing findings are recorded in
// `a11y-baseline.json` in the change that introduces the scan, and the gate
// ratchets in both directions: above the record is a regression, below it is a
// stale record that must be rewritten in the same change. The baseline is a
// COUNT AND A LIST — `D5` and the webview lint baseline both showed that a
// count-only record can say something got worse and cannot say which finding is
// new.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { openDashboard, THEMES, type ThemeName } from './a11y-harness';
import { EXCLUDED_ROUTES, ROUTE_MOUNT_TARGETS } from './routes';

const require = createRequire(__filename);
const AXE_PATH = require.resolve('axe-core/axe.min.js');
const BASELINE_PATH = resolve(__dirname, 'a11y-baseline.json');

/** The tag set that IS "WCAG 2.1 Level AA", spelled the way axe spells it. */
const WCAG_21_AA_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] as const;

interface Finding {
  readonly route: string;
  readonly theme: string;
  readonly ruleId: string;
  readonly selector: string;
}

interface Baseline {
  readonly target: string;
  readonly accepted: readonly Finding[];
}

interface AxeViolation {
  readonly id: string;
  readonly nodes: ReadonlyArray<{ readonly target: readonly string[] }>;
}

const key = (finding: Finding): string =>
  `${finding.route}|${finding.theme}|${finding.ruleId}|${finding.selector}`;

async function scanRoute(page: Page, route: string, theme: ThemeName): Promise<Finding[]> {
  const target = ROUTE_MOUNT_TARGETS[route as keyof typeof ROUTE_MOUNT_TARGETS];
  // `dashboard-route-<id>` is the nav control the app renders per route, and it
  // is the same one the visual suite drives. NOT wrapped in a catch: a route
  // that cannot be reached is a finding about the app, and swallowing the
  // navigation error would turn it into a confusing failure three lines later
  // about a page that had already gone.
  await page.getByTestId(`dashboard-route-${route}`).click();
  await page.getByTestId(target).first().waitFor({ state: 'visible', timeout: 15_000 });

  await page.addScriptTag({ path: AXE_PATH });
  const violations = (await page.evaluate(
    `axe.run(document, { runOnly: { type: 'tag', values: ${JSON.stringify(WCAG_21_AA_TAGS)} } })
       .then((r) => r.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => ({ target: n.target })) })))`
  )) as AxeViolation[];

  return violations.flatMap((violation) =>
    violation.nodes.map((node) => ({
      route,
      theme,
      ruleId: violation.id,
      selector: node.target.join(' ')
    }))
  );
}

test.describe('FR-R3-091 — WCAG 2.1 AA scan over every route and theme', () => {
  test('scans 21 combinations and holds them to the ratcheting baseline', async ({ page }) => {
    test.setTimeout(180_000);

    const routes = Object.keys(ROUTE_MOUNT_TARGETS).filter(
      (route) => !EXCLUDED_ROUTES.some((entry) => entry.route === route)
    );

    // The exclusion list is printed EVERY run, including when it is empty. An
    // undeclared limit gets read as full coverage.
    process.stdout.write(
      `\n[a11y] target: WCAG 2.1 Level AA (axe tags ${WCAG_21_AA_TAGS.join(', ')})\n` +
        `[a11y] surface: ${routes.length} route(s) x ${THEMES.length} theme(s) = ` +
        `${routes.length * THEMES.length} combination(s)\n` +
        `[a11y] excluded routes: ${
          EXCLUDED_ROUTES.length === 0
            ? '(none)'
            : EXCLUDED_ROUTES.map((entry) => `${entry.route} — ${entry.reason}`).join('; ')
        }\n` +
        `[a11y] AN AUTOMATED SCAN IS NOT CONFORMANCE. It finds what a rule engine can see in a\n` +
        `[a11y] rendered tree. Assistive-technology evidence lives in\n` +
        `[a11y] docs/release/accessibility-at-matrix.md, including the platforms recorded untested.\n`
    );

    const found: Finding[] = [];
    for (const theme of THEMES) {
      await openDashboard(page, theme);
      for (const route of routes) {
        found.push(...(await scanRoute(page, route, theme)));
      }
    }

    // Regeneration mode, used when the scan is first introduced and whenever a
    // finding is deliberately accepted. Gated on an env var rather than a flag so
    // no ordinary run can rewrite the record it is being judged against — a
    // baseline a test can silently update is not a baseline.
    if (process.env['SCHEGENT_A11Y_UPDATE_BASELINE'] === '1') {
      const existing = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Baseline & {
        about?: readonly string[];
      };
      writeFileSync(
        BASELINE_PATH,
        `${JSON.stringify(
          {
            about: existing.about,
            target: 'WCAG 2.1 Level AA',
            accepted: [...found].sort((a, b) => key(a).localeCompare(key(b)))
          },
          null,
          2
        )}\n`
      );
      process.stdout.write(`[a11y] baseline rewritten with ${found.length} accepted finding(s)\n`);
      return;
    }

    const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Baseline;
    expect(baseline.target, 'the baseline must state the target it was measured against').toBe(
      'WCAG 2.1 Level AA'
    );

    const accepted = new Set(baseline.accepted.map(key));
    const seen = new Set(found.map(key));

    // A rise NAMES the new findings. That is the whole difference from a count.
    const risen = found.filter((finding) => !accepted.has(key(finding)));
    // A fall means the record is stale, and a stale record lets the next
    // regression hide behind today's fix.
    const fallen = baseline.accepted.filter((finding) => !seen.has(key(finding)));

    process.stdout.write(
      `[a11y] findings: ${found.length}; baseline: ${baseline.accepted.length}; ` +
        `new: ${risen.length}; resolved: ${fallen.length}\n`
    );

    expect(
      risen.map(key),
      'New accessibility findings. Fix them, or — if they are accepted — add them to ' +
        'tests/a11y/a11y-baseline.json in this same change, with the count and the list together.'
    ).toEqual([]);
    expect(
      fallen.map(key),
      'These baseline entries no longer report. Remove them from tests/a11y/a11y-baseline.json ' +
        'in this same change: a stale record lets the next regression hide behind this fix.'
    ).toEqual([]);
  });
});
