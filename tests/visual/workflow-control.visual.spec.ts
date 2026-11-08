// FR-R5-F32 (F32-T08) — Visual & layout verification for CandidateBlockEditor
// and CandidateBlockInspector across light, dark, and high-contrast themes.

import { expect, test, type Page } from '@playwright/test';
import {
  buildCandidateBlockStateFixture,
  type CandidateBlockFrameState
} from '../../src/services/workflow-execution/workflow-control-projector';
import type { WorkflowSnapshot } from '../../src/ui/sidebar/snapshot';
import {
  POLICY_SMOKE_QUEUE_ID,
  POLICY_SMOKE_WORKFLOW_ID,
  policySmokeSnapshot
} from './fixtures/policy-smoke-snapshot';

type ThemeName = 'light' | 'dark' | 'high-contrast';

const THEME_CLASS: Readonly<Record<ThemeName, string>> = {
  light: 'vscode-light',
  dark: 'vscode-dark',
  'high-contrast': 'vscode-high-contrast'
};

const THEMES: readonly ThemeName[] = ['light', 'dark', 'high-contrast'];

function buildControlSnapshot(state: CandidateBlockFrameState): WorkflowSnapshot {
  const controlProjection = buildCandidateBlockStateFixture(state, {
    recoveryCoverage: 'partial',
    manifestTruncated: true,
    preexistingDirtyCount: 2,
    effectCertainty: state === 'intervention-required' ? 'uncertain' : 'safe',
    spendMode: 'strict-usd',
    spendEnforcementQuality: 'verified',
    verifiedMicrousd: 95_000,
    estimatedMicrousd: 110_000,
    unpricedAttemptCount: 0,
    maxMicrousd: 250_000,
    enclosingIteration: 2,
    enclosingMaxIterations: 4,
    durableNotices: ['Candidate cand-primary rate-limited; monitoring window active.'],
    evidenceRefs: ['ev-control-001']
  });

  return {
    ...policySmokeSnapshot,
    connectedRuns: [
      {
        connectedRunId: 'visual-task-active',
        workflowId: POLICY_SMOKE_WORKFLOW_ID,
        revision: 3,
        hydrating: false,
        queueId: POLICY_SMOKE_QUEUE_ID,
        status: 'in-flight',
        nodes: [
          {
            nodeId: 'triage',
            pipelineId: 'dev-new-feature',
            nodeKind: 'phase',
            state: 'in-flight',
            actions: [],
            attemptCount: 1
          }
        ],
        controlProjection
      }
    ]
  };
}

async function openControlDashboard(
  page: Page,
  theme: ThemeName,
  state: CandidateBlockFrameState
): Promise<void> {
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
  const snapshot = buildControlSnapshot(state);
  await page.evaluate((payload) => {
    const host = globalThis as unknown as { dispatchEvent(event: unknown): boolean };
    host.dispatchEvent(new MessageEvent('message', { data: { type: 'STATE_SNAPSHOT', payload } }));
  }, JSON.parse(JSON.stringify(snapshot)) as unknown);
}

test.describe('FR-R5-F32 — workflow control visual & layout checks', () => {
  for (const theme of THEMES) {
    test(`renders CandidateBlockEditor and CandidateBlockInspector in ${theme} theme with zero inline style attributes`, async ({
      page
    }) => {
      await openControlDashboard(page, theme, 'waiting-availability');

      // 1. Verify Builder CandidateBlockEditor and canvas banner
      await page.getByTestId('dashboard-route-builder').click();
      await expect(page.getByTestId('pipeline-builder-root')).toBeVisible();
      await page.getByRole('tab', { name: 'Workflows' }).click();
      const picker = page.getByTestId('workflow-picker-toggle');
      if ((await picker.getAttribute('aria-expanded')) !== 'true') {
        await picker.click();
      }
      await page.getByTestId(`workflows-list-item-${POLICY_SMOKE_WORKFLOW_ID}`).click();

      const editor = page.getByTestId('candidate-block-editor');
      await expect(editor).toBeVisible();
      await expect(page.getByTestId('workflow-canvas-candidate-block-banner')).toBeVisible();
      await expect(page.getByTestId('candidate-block-expanded-view')).toBeVisible();

      const editorInlineStyles = await editor.locator('[style]').count();
      expect(editorInlineStyles, 'CandidateBlockEditor must not emit inline style attributes').toBe(
        0
      );

      // Collapse and re-expand
      const expandToggle = page.getByTestId('candidate-block-expand-toggle');
      await expandToggle.click();
      await expect(page.getByTestId('candidate-block-collapsed-view')).toBeVisible();
      await expandToggle.click();
      await expect(page.getByTestId('candidate-block-expanded-view')).toBeVisible();

      // 2. Verify RunDetailTier CandidateBlockInspector
      await page.getByTestId('dashboard-route-operations').click();
      await page.getByTestId(`queue-card-${POLICY_SMOKE_QUEUE_ID}`).click();
      await page.getByTestId('queue-task-row-visual-task-active').click();

      const inspector = page.getByTestId('candidate-block-inspector');
      await expect(inspector).toBeVisible();
      await expect(page.getByTestId('candidate-block-inspector-state')).toHaveText(
        'waiting-availability'
      );
      await expect(page.getByTestId('candidate-block-inspector-recovery-coverage')).toContainText(
        'partial'
      );

      const inspectorInlineStyles = await inspector.locator('[style]').count();
      expect(
        inspectorInlineStyles,
        'CandidateBlockInspector must not emit inline style attributes'
      ).toBe(0);
    });
  }
});
