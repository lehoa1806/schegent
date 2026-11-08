// FR-R5-F32 (F32-T08) & FR-R5-F35 (F35-T05) — Accessibility (WCAG 2.1 AA axe-core + keyboard/ARIA)
// verification for CandidateBlockEditor, CandidateBlockInspector, Repeat projection, and ForEach
// projection across light, dark, and high-contrast themes.

import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';
import { buildCandidateBlockStateFixture } from '../../src/services/workflow-execution/workflow-control-projector';
import type { WorkflowSnapshot } from '../../src/ui/sidebar/snapshot';
import {
  POLICY_SMOKE_QUEUE_ID,
  POLICY_SMOKE_WORKFLOW_ID,
  policySmokeSnapshot
} from '../visual/fixtures/policy-smoke-snapshot';
import { THEME_CLASS, THEMES, type ThemeName } from './a11y-harness';

const require = createRequire(__filename);
const AXE_PATH = require.resolve('axe-core/axe.min.js');
const WCAG_21_AA_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] as const;

interface AxeViolation {
  readonly id: string;
  readonly nodes: ReadonlyArray<{ readonly target: readonly string[] }>;
}

function buildA11yControlSnapshot(): WorkflowSnapshot {
  const controlProjection = buildCandidateBlockStateFixture('monitoring-expired', {
    recoveryCoverage: 'partial',
    manifestTruncated: true,
    preexistingDirtyCount: 3,
    effectCertainty: 'uncertain',
    spendMode: 'strict-usd',
    spendEnforcementQuality: 'estimated',
    verifiedMicrousd: 80_000,
    estimatedMicrousd: 120_000,
    unpricedAttemptCount: 1,
    maxMicrousd: 200_000,
    enclosingIteration: 1,
    enclosingMaxIterations: 3,
    durableNotices: ['Monitoring window expired after 24h; renew monitoring to continue.'],
    evidenceRefs: ['ev-a11y-001']
  });

  return {
    ...policySmokeSnapshot,
    connectedRuns: [
      {
        connectedRunId: 'visual-task-active',
        workflowId: POLICY_SMOKE_WORKFLOW_ID,
        revision: 4,
        hydrating: false,
        queueId: POLICY_SMOKE_QUEUE_ID,
        status: 'paused',
        nodes: [
          {
            nodeId: 'triage',
            pipelineId: 'dev-new-feature',
            nodeKind: 'phase',
            state: 'in-flight',
            actions: [],
            attemptCount: 2,
            repeatProjection: {
              version: 1,
              kind: 'repeat',
              iteration: 3,
              currentPass: 3,
              maxIterations: 3,
              conditionResult: 'false',
              currentChildInvocationId: null,
              onExhausted: 'pause',
              exhaustionReason: 'repeat-exhausted',
              leafAttemptCount: 6,
              completedPasses: [
                { iteration: 1, invocationId: 'c-1', status: 'completed' },
                { iteration: 2, invocationId: 'c-2', status: 'completed' },
                { iteration: 3, invocationId: 'c-3', status: 'completed' }
              ],
              legalActions: [
                { kind: 'pause', allowed: false, reason: 'illegal-state' },
                { kind: 'resume', allowed: false, reason: 'illegal-state' },
                { kind: 'cancel', allowed: true }
              ]
            },
            forEachProjection: {
              version: 1,
              kind: 'for-each',
              collectionRef: 'fe-col-a11y',
              collectionSha256: 'cafebabe',
              itemCount: 2,
              currentIndex: 1,
              onItemError: 'continue',
              hasErrors: true,
              errorCount: 1,
              resultIndexRef: 'fe-idx-a11y',
              leafAttemptCount: 4,
              slots: [
                { index: 0, itemKey: 'item-1', state: 'completed', resultRef: 'res-0' },
                {
                  index: 1,
                  itemKey: 'item-2',
                  state: 'failed',
                  error: { code: 'child-failed', message: 'A11y item error' }
                }
              ]
            }
          }
        ],
        controlProjection
      }
    ]
  };
}

async function mountControlDashboard(page: Page, theme: ThemeName): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.emulateMedia({
    colorScheme: theme === 'light' ? 'light' : 'dark',
    reducedMotion: 'reduce',
    forcedColors: 'none'
  });
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === 'http://127.0.0.1:4173') {
      await route.continue();
      return;
    }
    await route.fulfill({ status: 200, contentType: 'text/css', body: '' });
  });
  await page.goto('/dashboard.html');
  const themeClass = THEME_CLASS[theme];
  await page.evaluate((cls) => {
    const doc = (globalThis as unknown as { document: { body: { classList: { remove(...c: string[]): void; add(c: string): void } } } }).document;
    doc.body.classList.remove(
      'vscode-light',
      'vscode-dark',
      'vscode-high-contrast',
      'vscode-high-contrast-light'
    );
    doc.body.classList.add(cls);
  }, themeClass);
  const snapshot = buildA11yControlSnapshot();
  await page.evaluate((payload) => {
    const host = globalThis as unknown as { dispatchEvent(event: unknown): boolean };
    host.dispatchEvent(new MessageEvent('message', { data: { type: 'STATE_SNAPSHOT', payload } }));
  }, JSON.parse(JSON.stringify(snapshot)) as unknown);
}

async function runScopedAxe(page: Page, selector: string): Promise<readonly AxeViolation[]> {
  await page.addScriptTag({ path: AXE_PATH });
  return (await page.evaluate(
    `axe.run(document.querySelector(${JSON.stringify(selector)}), { runOnly: { type: 'tag', values: ${JSON.stringify(WCAG_21_AA_TAGS)} } })
       .then((r) => r.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => ({ target: n.target })) })))`
  )) as AxeViolation[];
}

test.describe('FR-R5-F32 — WCAG 2.1 AA accessibility scan for workflow control surfaces', () => {
  for (const theme of THEMES) {
    test(`CandidateBlockEditor and CandidateBlockInspector pass WCAG 2.1 AA in ${theme} theme`, async ({
      page
    }) => {
      await mountControlDashboard(page, theme);

      // 1. Scan CandidateBlockEditor in Builder
      await page.getByTestId('dashboard-route-builder').click();
      await page.getByTestId('pipeline-builder-root').waitFor({ state: 'visible' });
      await page.getByRole('tab', { name: 'Workflows' }).click();
      const picker = page.getByTestId('workflow-picker-toggle');
      if ((await picker.getAttribute('aria-expanded')) !== 'true') {
        await picker.click();
      }
      await page.getByTestId(`workflows-list-item-${POLICY_SMOKE_WORKFLOW_ID}`).click();

      const editor = page.getByTestId('candidate-block-editor');
      await expect(editor).toBeVisible();
      await expect(page.getByTestId('candidate-block-expand-toggle')).toHaveAttribute(
        'aria-expanded',
        'true'
      );

      const editorViolations = await runScopedAxe(page, '[data-testid="candidate-block-editor"]');
      expect(editorViolations, `CandidateBlockEditor axe violations in ${theme}`).toEqual([]);

      // 2. Scan CandidateBlockInspector in RunDetailTier
      await page.getByTestId('dashboard-route-operations').click();
      await page.getByTestId(`queue-card-${POLICY_SMOKE_QUEUE_ID}`).click();
      await page.getByTestId('queue-task-row-visual-task-active').click();

      const inspector = page.getByTestId('candidate-block-inspector');
      await expect(inspector).toBeVisible();
      await expect(page.getByTestId('candidate-control-action-resume')).toBeDisabled();
      await expect(page.getByTestId('candidate-control-reason-resume')).toHaveText(
        'monitoring-expired'
      );

      const inspectorViolations = await runScopedAxe(
        page,
        '[data-testid="candidate-block-inspector"]'
      );
      expect(inspectorViolations, `CandidateBlockInspector axe violations in ${theme}`).toEqual([]);

      // 3. Scan Repeat and ForEach runtime projections in WorkflowNodeStates
      await expect(page.getByTestId('repeat-node-projection-triage')).toBeVisible();
      await expect(page.getByTestId('foreach-node-projection-triage')).toBeVisible();
      await expect(page.getByTestId('foreach-error-summary-triage')).toHaveAttribute(
        'role',
        'status'
      );

      const repeatViolations = await runScopedAxe(
        page,
        '[data-testid="repeat-node-projection-triage"]'
      );
      expect(repeatViolations, `Repeat projection axe violations in ${theme}`).toEqual([]);

      const forEachViolations = await runScopedAxe(
        page,
        '[data-testid="foreach-node-projection-triage"]'
      );
      expect(forEachViolations, `ForEach projection axe violations in ${theme}`).toEqual([]);
    });
  }
});

