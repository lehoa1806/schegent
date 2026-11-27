// FR-R3-091 — the whole-app accessibility scan.
//
// TARGET: **WCAG 2.1 Level AA**, over every shipped dashboard route in every
// shipped theme, plus one opened interaction state. The run prints the
// combination count it computed; this line no longer states one, because it
// said 21 after the sidebar was added 2026-08-28 (`FR-R3-131`) and said 24 after
// the route list had shrunk to six. The opened state was added 2026-11-06
// (`FR-R5-F20`): every earlier combination was a resting page, so no opened
// menu, dialog or popover had ever been scanned. The level is not
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
import { availabilityPhrase } from '../../src/contracts/change-review';
import type {
  ExecutionAttemptVisibility,
  OpenChangeReviewResponse,
  ReadExecutionVisibilityResponse,
  ReadReportResponse,
  RuntimePostureVisibility
} from '../../src/contracts/sidebar-ipc';
import { openDashboard, openSidebar, THEMES, type ThemeName } from './a11y-harness';
import { EXCLUDED_ROUTES, ROUTE_MOUNT_TARGETS } from './routes';

const require = createRequire(__filename);
const AXE_PATH = require.resolve('axe-core/axe.min.js');
const BASELINE_PATH = resolve(__dirname, 'a11y-baseline.json');

/**
 * The floor on node/rule pairs axe must have examined in the LEANEST
 * combination. Measured, printed every run, and lowered — never raised on a
 * hunch — when the surface legitimately shrinks.
 *
 * WHAT THE NUMBER IS FOR, because that decides where it sits. It separates
 * *rendered* from *blank*, not *big* from *small*. Measured 2026-08-28: 3,660
 * pairs across 24 combinations, leanest `sidebar|light` at 41; the mutation that
 * proved the floor fires — axe scoped to `document.head` — gave 1. So it sits at
 * roughly half the leanest real surface: far above a blank render, far enough
 * below the real figure that removing a decorative element does not fail a gate
 * about accessibility for a reason that has nothing to do with it.
 *
 * An earlier draft of this constant was 40, one below the leanest measurement.
 * That is a tripwire, not a floor.
 */
const MIN_NODES_EXAMINED = 20;

/** The routeless sidebar webview, as it appears in the baseline's `route` field. */
const SIDEBAR_SURFACE = 'sidebar';

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

/**
 * FR-R3-131 — the positive control, which this gate did not need until now.
 *
 * With 30 accepted findings, `findings: 0` was impossible: a harness that
 * rendered nothing would have failed on 30 fallen entries. At zero accepted, a
 * scan of a blank page reports EXACTLY what a clean sweep reports, and the
 * cycle's own success condition becomes indistinguishable from a broken
 * harness.
 *
 * So each combination reports how many element/rule pairs axe actually
 * examined — the nodes behind its `passes`, `violations` and `incomplete`
 * results — and the run asserts a floor. `MIN_NODES_EXAMINED` is measured, not
 * guessed: see the printed figures below and §D4 of the spec.
 */
interface ScanResult {
  readonly findings: readonly Finding[];
  readonly examined: number;
}

const key = (finding: Finding): string =>
  `${finding.route}|${finding.theme}|${finding.ruleId}|${finding.selector}`;

/** Run axe over whatever is currently rendered, and label it. */
async function scanRendered(page: Page, route: string, theme: ThemeName): Promise<ScanResult> {
  await page.addScriptTag({ path: AXE_PATH });
  // `examined` counts the node/rule pairs axe reached. It is deliberately taken
  // from axe's own results rather than from a `querySelectorAll` in the test:
  // the question the control answers is "did the RULE ENGINE see a tree", and a
  // DOM count in the harness would answer a different one.
  const result = (await page.evaluate(
    `axe.run(document, { runOnly: { type: 'tag', values: ${JSON.stringify(WCAG_21_AA_TAGS)} } })
       .then((r) => ({
         violations: r.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => ({ target: n.target })) })),
         examined: [...r.passes, ...r.violations, ...r.incomplete]
           .reduce((total, rule) => total + rule.nodes.length, 0)
       }))`
  )) as { violations: AxeViolation[]; examined: number };

  return {
    examined: result.examined,
    findings: result.violations.flatMap((violation) =>
      violation.nodes.map((node) => ({
        route,
        theme,
        ruleId: violation.id,
        selector: node.target.join(' ')
      }))
    )
  };
}

/**
 * FR-R5-F20 — one opened interaction state, labelled as its own surface.
 *
 * The Builder's Workflow picker is a popover, and the visual suite already opens
 * it. It opens by itself while no Workflow is selected, so the resting Builder
 * scan may already include it in that state. This scans the other state: a
 * Workflow selected, its editor showing, and the picker reopened from its toggle
 * on top of it.
 *
 * Visibility is asserted before the scan. A scan of a popover that never opened
 * reports the same automated findings as the closed page, and would claim
 * coverage it does not have.
 */
const OPENED_STATE_SURFACE = 'builder+workflow-picker-open';

async function scanOpenedPicker(page: Page, theme: ThemeName): Promise<ScanResult> {
  await page.getByTestId('dashboard-route-builder').click();
  await page.getByTestId('pipeline-builder-root').waitFor({ state: 'visible', timeout: 15_000 });
  await page.getByRole('tab', { name: 'Workflows' }).click();
  await page.getByTestId('workflows-list-item-dev-new-feature').click();
  await expect(page.getByTestId('workflow-field-name')).toBeVisible();
  const picker = page.getByTestId('workflow-picker-toggle');
  await expect(picker).toHaveAttribute('aria-expanded', 'false');
  await picker.click();
  await expect(picker).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('workflow-picker-list')).toBeVisible();
  return scanRendered(page, OPENED_STATE_SURFACE, theme);
}

async function scanRoute(page: Page, route: string, theme: ThemeName): Promise<ScanResult> {
  const target = ROUTE_MOUNT_TARGETS[route as keyof typeof ROUTE_MOUNT_TARGETS];
  // `dashboard-route-<id>` is the nav control the app renders per route, and it
  // is the same one the visual suite drives. NOT wrapped in a catch: a route
  // that cannot be reached is a finding about the app, and swallowing the
  // navigation error would turn it into a confusing failure three lines later
  // about a page that had already gone.
  await page.getByTestId(`dashboard-route-${route}`).click();
  await page.getByTestId(target).first().waitFor({ state: 'visible', timeout: 15_000 });
  if (route === 'settings') return scanSettingsSections(page, theme);
  return scanRendered(page, route, theme);
}

/**
 * The Settings route shows one section at a time and hides the rest, and axe skips hidden
 * content, so the route is scanned once per section, each shown by its navigation button, and
 * then once in each state a search gives the page (`eachSettingsSearchState`). Its findings keep
 * the route's key, `settings`, so the baseline's shape does not change, and a finding the scans
 * share (the page header, the navigation) is counted once.
 */
async function scanSettingsSections(page: Page, theme: ThemeName): Promise<ScanResult> {
  const buttons = page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button');
  const count = await buttons.count();
  expect(count, 'the Settings navigation lists its sections').toBeGreaterThan(1);
  const findings = new Map<string, Finding>();
  let examined = 0;
  const scan = async (): Promise<void> => {
    const result = await scanRendered(page, 'settings', theme);
    for (const finding of result.findings) findings.set(key(finding), finding);
    examined += result.examined;
  };
  for (let index = 0; index < count; index += 1) {
    const button = buttons.nth(index);
    await button.click();
    await expect(button).toHaveAttribute('aria-current', 'true');
    await scan();
  }
  await eachSettingsSearchState(page, scan);
  return { findings: [...findings.values()], examined };
}

/** A query that several Settings sections hold a match for, and one that no setting holds. */
const SETTINGS_QUERY = { found: 'retry', notFound: 'zzzz' } as const;

/**
 * A search gives the Settings page three states that no section shows, and `scan` runs in each:
 *
 * 1. Typing. Every section that holds a match is on screen under its name, what does not match
 *    is hidden, and the field has the focus, so its description is open over the page.
 * 2. Reading what was found, with the field left. Nothing stands over the sections now, so axe
 *    can judge what the description covered.
 * 3. A query no setting holds, which shows one line that says so.
 *
 * Each state is asserted before its scan. A search that changed nothing would report what the
 * section scans reported, and would claim coverage it does not have.
 */
async function eachSettingsSearchState(page: Page, scan: () => Promise<void>): Promise<void> {
  const field = page.getByTestId('settings-search');
  const description = page.locator('.hover-text-portal-host [role="tooltip"]');
  const shown = page.locator('[data-testid^="settings-section-"]:visible');

  await field.fill(SETTINGS_QUERY.found);
  await expect(description, 'the focused field shows its description').toBeVisible();
  await expect
    .poll(() => shown.count(), 'the search shows more than one section at once')
    .toBeGreaterThan(1);
  await scan();

  await field.blur();
  await expect(description, 'the description closes when the field is left').toHaveCount(0);
  await scan();

  await field.fill(SETTINGS_QUERY.notFound);
  await field.blur();
  await expect(description).toHaveCount(0);
  await expect(page.getByTestId('settings-search-empty')).toBeVisible();
  await scan();

  // The search ends here, so the page is left showing one section, as it was found.
  await field.fill('');
  await field.blur();
  await expect(shown).toHaveCount(1);
}

/**
 * The sidebar webview, scanned as its own surface (FR-R3-131).
 *
 * It has no routes: it is one panel. `sidebar` is therefore the `route` value in
 * every finding it produces, which keeps the baseline's key shape — route, theme,
 * rule, selector — unchanged.
 */
async function scanSidebar(page: Page, theme: ThemeName): Promise<ScanResult> {
  await openSidebar(page, theme);
  await page.getByTestId('app-root').waitFor({ state: 'visible', timeout: 15_000 });
  return scanRendered(page, SIDEBAR_SURFACE, theme);
}

test.describe('FR-R3-091 — WCAG 2.1 AA scan over every route and theme', () => {
  test('scans every route, the sidebar and one opened state per theme against the ratcheting baseline', async ({
    page
  }) => {
    test.setTimeout(180_000);

    const routes = Object.keys(ROUTE_MOUNT_TARGETS).filter(
      (route) => !EXCLUDED_ROUTES.some((entry) => entry.route === route)
    );
    const surfaces = routes.length + 2; // + the opened picker state + the sidebar webview

    // The exclusion list is printed EVERY run, including when it is empty. An
    // undeclared limit gets read as full coverage.
    process.stdout.write(
      `\n[a11y] target: WCAG 2.1 Level AA (axe tags ${WCAG_21_AA_TAGS.join(', ')})\n` +
        `[a11y] surface: ${routes.length} dashboard route(s) + 1 opened state (${OPENED_STATE_SURFACE}) + ` +
          `the sidebar webview = ` +
          `${surfaces} surface(s) x ${THEMES.length} theme(s) = ` +
          `${surfaces * THEMES.length} combination(s)\n` +
        `[a11y] excluded routes: ${
          EXCLUDED_ROUTES.length === 0
            ? '(none)'
            : EXCLUDED_ROUTES.map((entry) => `${entry.route} — ${entry.reason}`).join('; ')
        }\n` +
        `[a11y] These are automated findings. AN AUTOMATED SCAN IS NOT CONFORMANCE. It finds what a rule engine can see in a\n` +
        `[a11y] rendered tree. Assistive-technology evidence lives in\n` +
        `[a11y] docs/release/accessibility-at-matrix.md, including the platforms recorded untested.\n`
    );

    const found: Finding[] = [];
    const examined: Array<{ combination: string; nodes: number }> = [];
    for (const theme of THEMES) {
      await openDashboard(page, theme);
      for (const route of routes) {
        const result = await scanRoute(page, route, theme);
        found.push(...result.findings);
        examined.push({ combination: `${route}|${theme}`, nodes: result.examined });
      }
      const opened = await scanOpenedPicker(page, theme);
      found.push(...opened.findings);
      examined.push({ combination: `${OPENED_STATE_SURFACE}|${theme}`, nodes: opened.examined });
      // Last, because it navigates away from the dashboard document.
      const sidebar = await scanSidebar(page, theme);
      found.push(...sidebar.findings);
      examined.push({ combination: `${SIDEBAR_SURFACE}|${theme}`, nodes: sidebar.examined });
    }

    // Printed BEFORE the assertion, and printed on a green run too: the floor
    // below is only checkable against a figure someone can read.
    const leanest = examined.reduce((low, entry) => (entry.nodes < low.nodes ? entry : low));
    process.stdout.write(
      `[a11y] axe examined ${examined.reduce((total, entry) => total + entry.nodes, 0)} node/rule ` +
        `pair(s) across ${examined.length} combination(s); leanest was ${leanest.combination} at ` +
        `${leanest.nodes} (floor ${MIN_NODES_EXAMINED})\n`
    );
    expect(
      leanest.nodes,
      `Route/theme ${leanest.combination} gave axe only ${leanest.nodes} node/rule pair(s) to ` +
        'examine. With an empty baseline a scan of a blank page reports the same "0 findings" a ' +
        'clean scan does, so this floor is what separates them. Either the app did not render or ' +
        'the surface shrank; a legitimately smaller surface lowers MIN_NODES_EXAMINED in the same ' +
        'change, with the printed figure above as its evidence.'
    ).toBeGreaterThanOrEqual(MIN_NODES_EXAMINED);

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

// FR-R7-17 (T030) — Automated WCAG 2.1 AA axe, keyboard, focus, and target-size sanity scans for
// Historical Reports (Feature 310), Execution Visibility & Change Review (Feature 311), and
// Telemetry Runtime Health (Feature 313). AN AUTOMATED SCAN IS NOT CONFORMANCE: human screen-reader
// AT observation remains tracked in docs/release/accessibility-at-matrix.md.

const MIN_TARGET_SIZE_PX = 24;

interface Round6A11yFixtures {
  readonly listSaved: ReadReportResponse;
  readonly runReport: ReadReportResponse;
  readonly drillDown: ReadReportResponse;
  readonly runtimePosture: ReadExecutionVisibilityResponse;
  readonly attemptDetail: ExecutionAttemptVisibility;
  readonly openReview: OpenChangeReviewResponse;
  readonly refreshReview: OpenChangeReviewResponse;
  readonly classifyReview: OpenChangeReviewResponse;
}

function inlineFixtureJson(value: unknown): string {
  const encoded = JSON.stringify(value) as string | undefined;
  if (encoded === undefined) throw new Error('Round 6 a11y fixture is not JSON-serializable');
  return encoded.replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

function buildRound6A11yFixtures(): Round6A11yFixtures {
  const savedQuery = {
    view: 'execution-summary' as const,
    range: { startMs: 1_000, endMs: 2_000 },
    timezone: 'UTC',
    filters: {},
    groupBy: [] as const,
    sort: 'root-created-desc' as const,
    pageSize: 50
  };
  const reviewId = 'rev_123456789012345678';
  const comparisonRevision = `cr1-${'e'.repeat(64)}`;
  const reviewDescriptor = {
    reviewId,
    requestId: '4'.repeat(32),
    candidateId: 'cand-a11y-1',
    candidateCommit: 'c'.repeat(40),
    targetRef: 'refs/heads/main',
    targetCommit: 'a'.repeat(40),
    profileRevision: 1,
    profileDigest: 'd'.repeat(64),
    comparisonRevision,
    total: 12,
    loaded: 12,
    truncated: false,
    state: 'current' as const,
    reason: null,
    approval: { eligible: true, reason: null },
    landing: { eligible: false, reason: 'receipt-missing' as const },
    createdAt: '2026-11-23T00:00:00.000Z'
  };
  const changeEntries = Array.from({ length: 12 }, (_, index) => ({
    index,
    kind:
      index === 0
        ? ('added' as const)
        : index === 1
          ? ('renamed' as const)
          : index === 2
            ? ('deleted' as const)
            : ('modified' as const),
    oldPath: index === 0 ? null : `src/module-${index}/previous.ts`,
    newPath: index === 2 ? null : `src/module-${index}/updated.ts`,
    binary: index === 3,
    oldHandle: index === 0 ? null : `h-old-${index}`,
    newHandle: index === 2 ? null : `h-new-${index}`,
    similarity: index === 1 ? 92 : null
  }));

  const runtimePostureValue: RuntimePostureVisibility = {
    available: true,
    lanes: {
      enabled: true,
      liveLaneCap: 4,
      activeLanes: 1,
      totalLanes: 3,
      pendingIntegrations: 1
    },
    telemetry: {
      enabled: false,
      stateKind: 'refused',
      reasonCode: 'content-export-unsupported',
      protocol: 'otlp-http-json',
      contentPolicyMode: 'content',
      pendingCopyCount: 0,
      exportedCopyCount: 0,
      droppedCopyCount: 0,
      spooledBatchCount: 0,
      spooledBytes: 0,
      spoolCeilingBytes: 32 * 1024 * 1024,
      activeSeriesCount: 0,
      seriesCap: 1_000,
      overflowCount: 0,
      previewSummary:
        'Metrics only (metadata-only allowlist). Content export is unsupported and refused.'
    }
  };

  const attemptDetail: ExecutionAttemptVisibility = {
    available: true,
    unavailableReason: null,
    rootExecutionId: 'visual-run-active',
    hierarchy: {
      rootStatus: 'paused',
      workflowId: 'dev-new-feature',
      frozenDefinitionId: 'fc-a11y-1',
      invocationCount: 2,
      attemptCount: 2,
      dataQuality: 'partial',
      attempts: [
        {
          attemptId: 'att-1',
          stepIndex: 0,
          phaseId: 'speckit-plan',
          attemptNumber: 1,
          status: 'succeeded',
          exitCode: 0,
          startedAtMs: 1_760_000_000_000,
          completedAtMs: 1_760_000_060_000,
          backendKind: 'claude',
          modelId: 'claude-sonnet-4-6',
          profileId: 'claude-acp-bridge',
          laneId: '1'.repeat(32),
          failureCause: null
        },
        {
          attemptId: 'att-2',
          stepIndex: 1,
          phaseId: 'speckit-implement',
          attemptNumber: 1,
          status: 'paused',
          exitCode: null,
          startedAtMs: 1_760_000_070_000,
          completedAtMs: null,
          backendKind: 'claude',
          modelId: 'claude-sonnet-4-6',
          profileId: 'claude-acp-bridge',
          laneId: '1'.repeat(32),
          failureCause: null
        }
      ]
    },
    evidence: [
      {
        artifactId: 'art-expired-1',
        rootId: 'visual-run-active',
        attemptId: 'att-1',
        storeKind: 'diagnostic',
        availability: 'expired',
        byteSize: 512,
        retentionClass: 'transcripts-diagnostics-checkpoints-audit-catalog'
      }
    ],
    liveLog: { streamState: 'partial', segmentCount: 3, gapCount: 1 },
    recovery: { posture: 'uncertain', reasonCode: 'restart-before-ack' },
    acp: {
      runtimeState: 'awaiting-permission',
      profileId: 'claude-acp-bridge',
      backendKind: 'claude',
      modelId: 'claude-sonnet-4-6',
      liveObservations: 4,
      pendingPermissions: 1
    },
    lane: {
      mode: 'isolated-lane',
      laneId: '1'.repeat(32),
      laneState: 'completed',
      candidateId: 'cand-a11y-1',
      integrationRequestId: '4'.repeat(32),
      integrationState: 'awaiting-review',
      targetRef: 'refs/heads/main',
      comparisonRevision
    },
    handoffs: [
      {
        handoffId: 'ho-a11y-1',
        recordVersion: 1,
        identity: {
          workspaceId: 'ws-a11y',
          rootExecutionId: 'visual-run-active',
          sourceInvocationId: 'inv-1',
          targetNodePath: 'speckit-implement',
          targetOccurrenceId: 'occ-1',
          inputEnvelopeRevision: 1,
          sourceAttempts: []
        },
        revisions: [
          {
            revision: 1,
            manifestDigest: 'a'.repeat(64),
            rendererVersion: 1,
            renderedDigest: 'b'.repeat(64),
            renderedBytes: 128,
            state: 'waiting-approval'
          }
        ],
        revision: 1,
        origin: 'selected',
        approval: 'manual',
        session: 'fresh',
        policyDigest: 'c'.repeat(64),
        cutoffSequence: 1,
        renderedBytesMax: 32 * 1024,
        sources: [],
        omissions: [],
        omissionsUnlisted: 0,
        approvals: [],
        dispatches: []
      }
    ],
    reviewLoops: [
      {
        loopId: 'rl-a11y-1',
        rootId: 'visual-run-active',
        nodeId: 'review',
        iteration: 1,
        verdict: 'changes-requested',
        candidateRef: 'cand-a11y-1',
        openFindings: 1,
        resolvedFindings: 2,
        totalFindings: 3
      }
    ]
  };

  return {
    listSaved: {
      op: 'listSaved',
      result: {
        ok: true,
        value: {
          items: [
            {
              reportId: 'rep-saved-1',
              rerunOf: null,
              view: 'execution-summary',
              query: savedQuery,
              manifestSha256: 'b'.repeat(64),
              createdUtc: '2026-11-23T00:00:00.000Z',
              manifest: {
                schema: 'schegent.report-manifest',
                manifestVersion: 1,
                reportId: 'rep-saved-1',
                exportId: null,
                rerunOf: null,
                view: 'execution-summary',
                query: savedQuery,
                queryDigest: 'c'.repeat(64),
                generatedUtc: '2026-11-23T00:00:00.000Z',
                sourceCutoffUtc: '2026-11-23T00:00:00.000Z',
                timezone: 'UTC',
                timeBasis: 'root-created',
                versions: {
                  source: 'sqlite-store/9',
                  schema: 1,
                  calculation: 1,
                  accountingPolicy: null,
                  accountingCalculation: null
                },
                accountingRevision: null,
                rowCount: 2,
                units: ['ms'],
                privacyProfile: 'metadata-only',
                retention: 'outside-managed-retention',
                populationDigest: 'a'.repeat(64),
                coverage: {
                  roots: 2,
                  attempts: 3,
                  unknownDurations: 1,
                  unattributed: null,
                  gaps: []
                },
                omissions: []
              }
            }
          ],
          cursor: null
        }
      }
    },
    runReport: {
      op: 'run',
      result: {
        ok: true,
        value: {
          reportId: 'rep-a11y-1',
          outcome: 'complete',
          view: 'execution-summary',
          sourceCutoffUtc: '2026-11-23T01:00:00.000Z',
          timeBasis: 'root-created',
          accountingRevision: null,
          calculationVersion: 1,
          rowCount: 2,
          coverage: { roots: 2, attempts: 3, unknownDurations: 1 },
          omissions: [{ what: 'accounting', reason: 'accounting-unavailable' }],
          rows: [
            {
              kind: 'root',
              rootId: 'run-alpha',
              workflowId: 'dev-new-feature',
              frozenDefinitionId: null,
              outcome: 'succeeded',
              createdUtc: '2026-11-23T00:30:00.000Z',
              durationMs: null,
              attempts: 2
            },
            {
              kind: 'root',
              rootId: 'run-beta',
              workflowId: 'bugfix',
              frozenDefinitionId: 'fc-2',
              outcome: 'failed',
              createdUtc: '2026-11-22T22:15:00.000Z',
              durationMs: 42_000,
              attempts: 1
            }
          ],
          cursor: null
        }
      }
    },
    drillDown: {
      op: 'drillDown',
      result: {
        ok: true,
        value: {
          reportId: 'rep-a11y-1',
          root: {
            kind: 'root',
            rootId: 'run-alpha',
            workflowId: 'dev-new-feature',
            frozenDefinitionId: null,
            outcome: 'succeeded',
            createdUtc: '2026-11-23T00:30:00.000Z',
            durationMs: null,
            attempts: 2
          },
          frozenDefinitionId: null,
          outcomeLineage: [{ source: 'run-store', outcome: 'succeeded' }],
          attempts: [
            {
              kind: 'attempt',
              attemptId: 'att-1',
              rootId: 'run-alpha',
              stepIndex: 0,
              phaseId: 'speckit-plan',
              attemptNumber: 1,
              status: 'succeeded',
              exitCode: 0,
              startedUtc: '2026-11-23T00:30:00.000Z',
              completedUtc: null,
              durationMs: null
            }
          ],
          usage: null,
          omissions: [{ what: 'accounting', reason: 'accounting-unavailable' }],
          evidenceRefs: [
            {
              artifactId: 'art-1',
              rootId: 'run-alpha',
              attemptId: 'att-1',
              storeKind: 'diagnostic',
              availability: 'present',
              byteSize: 256,
              retentionClass: 'transcripts-diagnostics-checkpoints-audit-catalog'
            }
          ],
          acpAttributions: [
            {
              attemptId: 'att-1',
              rootId: 'run-alpha',
              backendKind: 'claude',
              modelId: 'claude-sonnet-4-6',
              profileId: 'claude-acp-bridge',
              laneId: '1'.repeat(32),
              liveObservations: 4
            }
          ],
          handoffSummaries: [],
          reviewSummaries: []
        }
      }
    },
    runtimePosture: {
      op: 'runtimePosture',
      posture: runtimePostureValue
    },
    attemptDetail,
    openReview: {
      op: 'open',
      editor: { mode: 'none', opened: 0 },
      result: {
        ok: true,
        value: {
          state: 'current',
          reason: null,
          review: reviewDescriptor,
          firstPage: {
            reviewId,
            entries: changeEntries,
            nextCursor: null
          }
        }
      }
    },
    refreshReview: {
      op: 'refresh',
      editor: { mode: 'none', opened: 0 },
      result: {
        ok: true,
        value: {
          state: 'current',
          reason: null,
          review: reviewDescriptor,
          firstPage: {
            reviewId,
            entries: changeEntries,
            nextCursor: null
          }
        }
      }
    },
    classifyReview: {
      op: 'classify',
      result: { ok: true, value: reviewDescriptor }
    }
  };
}

async function installRound6HostBridge(page: Page): Promise<void> {
  const fixturesJson = inlineFixtureJson(buildRound6A11yFixtures());
  await page.addInitScript({
    content: `(() => {
      const fixtures = ${fixturesJson};
      let persistedState;
      const emit = (data) => {
        window.dispatchEvent(new MessageEvent('message', { data }));
      };
      const api = {
        postMessage(message) {
          if (!message || typeof message !== 'object') return;
          if (typeof message.correlationId !== 'string') return;
          const payload = message.payload && typeof message.payload === 'object' ? message.payload : {};
          let result;
          if (message.type === 'CMD_READ_REPORT') {
            if (payload.op === 'listSaved') result = fixtures.listSaved;
            else if (payload.op === 'run' || payload.op === 'rerunSaved') result = fixtures.runReport;
            else if (payload.op === 'drillDown') result = fixtures.drillDown;
            else if (payload.op === 'close') result = { op: 'close', result: { ok: true, value: { released: true } } };
            else if (payload.op === 'cancelActive') result = { op: 'cancelActive', canceled: true };
            else if (payload.op === 'reproduceSaved') {
              result = { op: 'reproduceSaved', result: { ok: true, value: { verdict: 'reproduced', reason: null } } };
            }
          } else if (message.type === 'CMD_MUTATE_REPORT') {
            if (payload.op === 'deleteSaved') {
              result = { op: 'deleteSaved', result: { ok: true, value: { deleted: true } } };
            }
          } else if (message.type === 'CMD_READ_EXECUTION_VISIBILITY') {
            if (payload.op === 'runtimePosture') result = fixtures.runtimePosture;
            else if (payload.op === 'attemptDetail') {
              result = {
                op: 'attemptDetail',
                detail: {
                  ...fixtures.attemptDetail,
                  rootExecutionId:
                    typeof payload.rootExecutionId === 'string'
                      ? payload.rootExecutionId
                      : fixtures.attemptDetail.rootExecutionId
                }
              };
            }
          } else if (message.type === 'CMD_OPEN_CHANGE_REVIEW') {
            if (payload.op === 'open') result = fixtures.openReview;
            else if (payload.op === 'refresh') result = fixtures.refreshReview;
            else if (payload.op === 'classify') result = fixtures.classifyReview;
            else if (payload.op === 'close') result = { op: 'close', closed: true };
            else if (payload.op === 'cancelOpen') result = { op: 'cancelOpen', canceled: true };
          } else if (message.type === 'CMD_DECIDE_PHASE_HANDOFF') {
            if (payload.op === 'approve') result = { op: 'approve', result: { ok: true, revision: 1 } };
          }
          window.setTimeout(() => {
            emit({
              type: 'CMD_ACK',
              correlationId: message.correlationId,
              status: 'accepted',
              result
            });
          }, 0);
        },
        setState(state) { persistedState = state; },
        getState() { return persistedState; }
      };
      Object.defineProperty(window, 'acquireVsCodeApi', {
        configurable: false,
        enumerable: false,
        value: () => api
      });
    })();`
  });
}

async function assertMinTargetSizes(
  page: Page,
  testIds: readonly string[],
  surfaceLabel: string
): Promise<void> {
  for (const testId of testIds) {
    const locator = page.getByTestId(testId);
    await expect(locator, `${surfaceLabel}: ${testId} must be visible`).toBeVisible();
    const box = await locator.boundingBox();
    expect(box, `${surfaceLabel}: ${testId} must have a layout box`).not.toBeNull();
    expect(
      box!.width,
      `${surfaceLabel}: ${testId} width (${String(box!.width)}px) below ${String(MIN_TARGET_SIZE_PX)}px floor`
    ).toBeGreaterThanOrEqual(MIN_TARGET_SIZE_PX);
    expect(
      box!.height,
      `${surfaceLabel}: ${testId} height (${String(box!.height)}px) below ${String(MIN_TARGET_SIZE_PX)}px floor`
    ).toBeGreaterThanOrEqual(MIN_TARGET_SIZE_PX);
  }
}

test.describe('FR-R7-17 — WCAG 2.1 AA, keyboard, focus & target-size scan for Historical Reports, Execution Visibility, Change Review & Runtime Health', () => {
  for (const theme of THEMES) {
    test(`Historical Reports, Runtime Health, Execution Visibility & Change Review pass automated axe + keyboard/focus/target checks in ${theme} theme`, async ({
      page
    }) => {
      await installRound6HostBridge(page);
      await openDashboard(page, theme);

      // 1. Historical Reports tab under Metrics (`metrics-mode-reports`)
      await page.getByTestId('dashboard-route-metrics').click();
      await page.getByTestId('metrics-section').waitFor({ state: 'visible', timeout: 15_000 });
      const rollupTab = page.getByTestId('metrics-mode-rollup');
      const reportsTab = page.getByTestId('metrics-mode-reports');
      await rollupTab.focus();
      await expect(rollupTab).toBeFocused();
      await page.keyboard.press('ArrowRight');
      await expect(reportsTab).toBeFocused();
      await expect(reportsTab).toHaveAttribute('aria-selected', 'true');

      await expect(page.getByTestId('historical-reports-panel')).toBeVisible();
      await expect(page.getByTestId('report-rows-table')).toBeVisible();
      await expect(page.getByTestId('report-retention-disclosure')).toContainText(
        'outside-managed-retention'
      );
      await expect(page.getByTestId('saved-reports-retention-note')).toBeVisible();
      await expect(page.getByTestId('report-rows-table')).toContainText(
        availabilityPhrase('unknown')
      );

      // Expand report coverage disclosure and open root drill-down via keyboard
      await page.locator('[data-testid="historical-reports-panel"] details.diag > summary').click();
      await expect(page.getByTestId('report-coverage-strip')).toBeVisible();

      const drillTrigger = page.getByTestId('report-drilldown-open-run-alpha');
      await drillTrigger.focus();
      await expect(drillTrigger).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('report-drilldown-panel')).toBeVisible();

      const reportsScan = await scanRendered(page, 'metrics+reports-drilldown', theme);
      expect(reportsScan.examined).toBeGreaterThanOrEqual(MIN_NODES_EXAMINED);
      expect(
        reportsScan.findings.map(key),
        `Historical Reports axe findings in ${theme}`
      ).toEqual([]);

      await assertMinTargetSizes(
        page,
        [
          'metrics-mode-reports',
          'report-view-select',
          'report-range-select',
          'report-run-button',
          'report-save-button',
          'report-drilldown-close'
        ],
        `Historical Reports (${theme})`
      );

      // Closing drill-down restores keyboard focus to the triggering row button
      const closeDrill = page.getByTestId('report-drilldown-close');
      await closeDrill.focus();
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('report-drilldown-panel')).toHaveCount(0);
      await expect(drillTrigger).toBeFocused();

      // Two-step saved-report deletion focus flow (Delete -> Confirm delete focused -> Keep returns focus)
      await page.getByTestId('saved-actions-rep-saved-1').click();
      await page.getByTestId('saved-delete-rep-saved-1').click();
      const confirmDeleteBtn = page.getByTestId('saved-confirm-delete-rep-saved-1');
      await expect(confirmDeleteBtn).toBeVisible();
      await expect(confirmDeleteBtn).toBeFocused();
      await page.getByRole('button', { name: 'Keep' }).click();
      await expect(confirmDeleteBtn).toHaveCount(0);

      // 2. System tab -> Runtime (`TelemetryRuntimeHealthPanel`)
      await page.getByTestId('dashboard-route-system').click();
      await page.getByTestId('system-tab').waitFor({ state: 'visible', timeout: 15_000 });
      const debugTab = page.getByTestId('system-view-debug');
      const runtimeTab = page.getByTestId('system-view-telemetry');
      await debugTab.focus();
      await page.keyboard.press('End');
      await expect(runtimeTab).toBeFocused();
      await expect(runtimeTab).toHaveAttribute('aria-selected', 'true');

      await expect(page.getByTestId('telemetry-runtime-health-panel')).toBeVisible();
      await expect(page.getByTestId('otlp-health-card')).toBeVisible();
      await expect(page.getByTestId('lanes-health-card')).toBeVisible();
      await expect(page.getByTestId('telemetry-refusal-notice')).toContainText(
        'content-export-unsupported'
      );

      const runtimeDiagSummaries = page.locator(
        '[data-testid="telemetry-runtime-health-panel"] details.diag > summary'
      );
      const diagCount = await runtimeDiagSummaries.count();
      for (let idx = 0; idx < diagCount; idx += 1) {
        await runtimeDiagSummaries.nth(idx).click();
      }

      const runtimeScan = await scanRendered(page, 'system+runtime-health', theme);
      expect(runtimeScan.examined).toBeGreaterThanOrEqual(MIN_NODES_EXAMINED);
      expect(
        runtimeScan.findings.map(key),
        `TelemetryRuntimeHealthPanel axe findings in ${theme}`
      ).toEqual([]);

      const runtimeRefresh = page.getByTestId('runtime-health-refresh');
      await runtimeRefresh.focus();
      await expect(runtimeRefresh).toBeFocused();
      await assertMinTargetSizes(
        page,
        ['system-view-telemetry', 'runtime-health-refresh'],
        `Telemetry Runtime Health (${theme})`
      );

      // 3. Active Operations drill-down with expanded ExecutionVisibilityPanel & ChangeReviewPanel
      await page.getByTestId('dashboard-route-operations').click();
      await page.getByTestId('queues-tier').waitFor({ state: 'visible', timeout: 15_000 });
      await page.getByTestId('queue-card-default').click();
      await page.getByTestId('queue-task-row-visual-task-active').click();
      await expect(page.getByTestId('run-detail-tier')).toBeVisible();
      await page.getByRole('tab', { name: 'Context' }).click();

      // Waiting-approval handoff auto-opens ExecutionVisibilityPanel; verify distinct non-numeric phrases
      await expect(page.getByTestId('execution-visibility-posture')).toBeVisible();
      await expect(page.getByTestId('ev-evidence')).toContainText(availabilityPhrase('expired'));
      await expect(page.getByTestId('ev-recovery')).toContainText(availabilityPhrase('uncertain'));
      await expect(page.getByTestId('ev-acp')).toContainText('awaiting-permission');
      await expect(page.getByTestId('ev-attempts-section')).toBeVisible();
      await expect(page.getByTestId('change-review-panel')).toBeVisible();

      // Open Change Review file inventory and verify keyboard scrolling on `.cr-files`
      await page.getByTestId('change-review-inspect-btn').click();
      await expect(page.getByTestId('change-review-posture')).toBeVisible();
      const fileList = page.getByTestId('change-review-file-list');
      await expect(fileList).toBeVisible();
      await expect(fileList).toHaveAttribute('tabindex', '0');

      const activeVisibilityScan = await scanRendered(
        page,
        'operations+execution-visibility-change-review',
        theme
      );
      expect(activeVisibilityScan.examined).toBeGreaterThanOrEqual(MIN_NODES_EXAMINED);
      expect(
        activeVisibilityScan.findings.map(key),
        `Active ExecutionVisibilityPanel + ChangeReviewPanel axe findings in ${theme}`
      ).toEqual([]);

      await assertMinTargetSizes(
        page,
        [
          'execution-visibility-refresh',
          'ev-attempt-all',
          'change-review-inspect-btn',
          'change-review-refresh-btn',
          'change-review-close-btn',
          'ev-handoff-approve-ho-a11y-1'
        ],
        `Active Execution Visibility & Change Review (${theme})`
      );

      // Verify keyboard focus and scrolling on `.cr-files`
      await fileList.focus();
      await expect(fileList).toBeFocused();
      const scrollMetrics = (await page.evaluate(`(() => {
        const el = document.querySelector('[data-testid="change-review-file-list"]');
        return el ? { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight } : null;
      })()`)) as { scrollHeight: number; clientHeight: number } | null;
      expect(scrollMetrics).not.toBeNull();
      expect(scrollMetrics!.scrollHeight).toBeGreaterThan(scrollMetrics!.clientHeight);
      await page.keyboard.press('PageDown');
      await expect
        .poll(() =>
          page.evaluate(
            `document.querySelector('[data-testid="change-review-file-list"]')?.scrollTop ?? 0`
          )
        )
        .toBeGreaterThan(0);

      // Refresh & close review update polite live status cleanly
      await page.getByTestId('change-review-refresh-btn').click();
      await expect(page.getByTestId('change-review-status')).toContainText('Refreshed 12 of 12');
      await page.getByTestId('change-review-close-btn').click();
      await expect(page.getByTestId('change-review-file-list')).toHaveCount(0);
      await expect(page.getByTestId('change-review-status')).toContainText(
        'Closed candidate change review.'
      );

      // 4. History drill-down drawer with expanded ExecutionVisibilityPanel & ChangeReviewPanel
      await page.getByTestId('dashboard-route-history').click();
      await page.getByTestId('history-dashboard').waitFor({ state: 'visible', timeout: 15_000 });
      await page.getByTestId('history-item-open-details-visual-run-complete').click();
      await expect(page.getByTestId('execution-visibility-posture')).toBeVisible();
      await page.getByTestId('change-review-inspect-btn').click();
      await expect(page.getByTestId('change-review-file-list')).toBeVisible();

      const historyVisibilityScan = await scanRendered(
        page,
        'history+execution-visibility-change-review',
        theme
      );
      expect(historyVisibilityScan.examined).toBeGreaterThanOrEqual(MIN_NODES_EXAMINED);
      expect(
        historyVisibilityScan.findings.map(key),
        `History ExecutionVisibilityPanel + ChangeReviewPanel axe findings in ${theme}`
      ).toEqual([]);
    });
  }
});

test.describe('FR-R8-03 (03-07) — Small-viewport (1000x600) & interactive-state WCAG 2.1 AA, keyboard, focus, and high-contrast scan', () => {
  for (const theme of THEMES) {
    test(`Small viewport (1000x600) preserves zero axe findings, keyboard flow, focus retention, and target sizes across interactive states in ${theme} theme`, async ({
      page
    }) => {
      await installRound6HostBridge(page);
      await openDashboard(page, theme);
      await page.setViewportSize({ width: 1000, height: 600 });

      // 1. Settings privacy profile & retention disclosure interactive state at small viewport
      await page.getByTestId('dashboard-route-settings').click();
      await page.getByTestId('settings-search').waitFor({ state: 'visible', timeout: 15_000 });
      const navButtons = page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button');
      const privacyBtn = navButtons.filter({ hasText: /Privacy|Logging|Evidence/i }).first();
      await expect(privacyBtn).toBeVisible();
      await privacyBtn.focus();
      await expect(privacyBtn).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(privacyBtn).toHaveAttribute('aria-current', 'true');

      const smallSettingsScan = await scanRendered(page, 'small-viewport+settings-privacy', theme);
      expect(smallSettingsScan.examined).toBeGreaterThanOrEqual(MIN_NODES_EXAMINED);
      expect(
        smallSettingsScan.findings.map(key),
        `Small-viewport Settings privacy/logging axe findings in ${theme}`
      ).toEqual([]);

      // 2. System -> Runtime Health & Isolated Workspaces diagnostics expanded at small viewport
      await page.getByTestId('dashboard-route-system').click();
      await page.getByTestId('system-tab').waitFor({ state: 'visible', timeout: 15_000 });
      const runtimeTab = page.getByTestId('system-view-telemetry');
      await runtimeTab.focus();
      await page.keyboard.press('Enter');
      await expect(runtimeTab).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByTestId('lanes-health-card')).toBeVisible();
      await expect(page.getByTestId('otlp-health-card')).toBeVisible();

      const laneDiagSummary = page.locator('[data-testid="lanes-health-card"] details.diag > summary');
      await laneDiagSummary.focus();
      await expect(laneDiagSummary).toBeFocused();
      await page.keyboard.press('Enter');

      const smallRuntimeScan = await scanRendered(page, 'small-viewport+system-runtime-lanes', theme);
      expect(smallRuntimeScan.examined).toBeGreaterThanOrEqual(MIN_NODES_EXAMINED);
      expect(
        smallRuntimeScan.findings.map(key),
        `Small-viewport Runtime/Lanes axe findings in ${theme}`
      ).toEqual([]);

      await assertMinTargetSizes(
        page,
        ['system-view-telemetry', 'runtime-health-refresh'],
        `Small-viewport Runtime Health (${theme})`
      );

      // 3. Operations drill-down + ExecutionVisibility + ChangeReview file inventory at small viewport
      await page.getByTestId('dashboard-route-operations').click();
      await page.getByTestId('queues-tier').waitFor({ state: 'visible', timeout: 15_000 });
      await page.getByTestId('queue-card-default').click();
      await page.getByTestId('queue-task-row-visual-task-active').click();
      await expect(page.getByTestId('run-detail-tier')).toBeVisible();
      await page.getByRole('tab', { name: 'Context' }).click();
      await expect(page.getByTestId('execution-visibility-posture')).toBeVisible();
      await page.getByTestId('change-review-inspect-btn').click();
      await expect(page.getByTestId('change-review-file-list')).toBeVisible();

      const smallOpsScan = await scanRendered(page, 'small-viewport+operations-visibility-review', theme);
      expect(smallOpsScan.examined).toBeGreaterThanOrEqual(MIN_NODES_EXAMINED);
      expect(
        smallOpsScan.findings.map(key),
        `Small-viewport Operations visibility + change review axe findings in ${theme}`
      ).toEqual([]);

      await assertMinTargetSizes(
        page,
        ['change-review-refresh-btn', 'change-review-close-btn', 'execution-visibility-refresh'],
        `Small-viewport Operations (${theme})`
      );

      // 4. Metrics -> Historical Reports two-step deletion confirm at small viewport
      await page.getByTestId('dashboard-route-metrics').click();
      await page.getByTestId('metrics-section').waitFor({ state: 'visible', timeout: 15_000 });
      const reportsTab = page.getByTestId('metrics-mode-reports');
      await reportsTab.click();
      await expect(page.getByTestId('historical-reports-panel')).toBeVisible();
      await expect(page.getByTestId('report-rows-table')).toBeVisible();
      const savedActionsBtn = page.getByTestId('saved-actions-rep-saved-1');
      await savedActionsBtn.scrollIntoViewIfNeeded();
      await expect(savedActionsBtn).toBeVisible();
      await savedActionsBtn.focus();
      await expect(savedActionsBtn).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(savedActionsBtn).toHaveAttribute('aria-expanded', 'true');
      const deleteMenuItem = page.getByTestId('saved-delete-rep-saved-1');
      await expect(deleteMenuItem).toBeVisible();
      await page.keyboard.press('End');
      await expect(deleteMenuItem).toBeFocused();
      await page.keyboard.press('Enter');
      const confirmDeleteBtn = page.getByTestId('saved-confirm-delete-rep-saved-1');
      await expect(confirmDeleteBtn).toBeVisible();
      await expect(confirmDeleteBtn).toBeFocused();

      const smallDeleteScan = await scanRendered(page, 'small-viewport+reports-delete-confirm', theme);
      expect(smallDeleteScan.examined).toBeGreaterThanOrEqual(MIN_NODES_EXAMINED);
      expect(
        smallDeleteScan.findings.map(key),
        `Small-viewport Reports two-step delete confirm axe findings in ${theme}`
      ).toEqual([]);

      // Keyboard Escape or Keep dismisses confirmation cleanly
      await page.getByRole('button', { name: 'Keep' }).click();
      await expect(confirmDeleteBtn).toHaveCount(0);
    });
  }
});
