// FR-R5-F32 (F32-T08) & FR-R5-F35 (F35-T05) — Visual & layout verification for
// CandidateBlockEditor, CandidateBlockInspector, Repeat projection, and ForEach
// projection across light, dark, and high-contrast themes.

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
            attemptCount: 1,
            repeatProjection: {
              version: 1,
              kind: 'repeat',
              iteration: 2,
              currentPass: 2,
              maxIterations: 4,
              conditionResult: 'false',
              currentChildInvocationId: 'child-inv-2',
              onExhausted: 'pause',
              exhaustionReason: 'repeat-exhausted',
              carryEnvelopeRef: 'root:triage:pass-2:carry',
              leafAttemptCount: 5,
              completedPasses: [
                { iteration: 1, invocationId: 'child-inv-1', status: 'completed', resultRef: 'ref:1' }
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
              collectionRef: 'fe-col-001',
              collectionSha256: 'deadbeef',
              itemCount: 3,
              currentIndex: 2,
              onItemError: 'continue',
              hasErrors: true,
              errorCount: 1,
              resultIndexRef: 'fe-idx-001',
              leafAttemptCount: 6,
              slots: [
                { index: 0, itemKey: 'item-a', state: 'completed', resultRef: 'res-0' },
                {
                  index: 1,
                  itemKey: 'item-b',
                  state: 'failed',
                  error: { code: 'child-failed', message: 'Item failed cleanly' }
                },
                { index: 2, itemKey: 'item-c', state: 'completed', resultRef: 'res-2' }
              ]
            }
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

      // 3. Verify Repeat and ForEach runtime projections in WorkflowNodeStates
      const repeatPanel = page.getByTestId('repeat-node-projection-triage');
      await expect(repeatPanel).toBeVisible();
      await expect(page.getByTestId('repeat-pass-counter-triage')).toContainText('Pass 2 of 4');
      await expect(page.getByTestId('repeat-leaf-attempts-triage')).toContainText('5 leaf attempts');
      await expect(page.getByTestId('repeat-exhaustion-reason-triage')).toContainText('repeat-exhausted');
      expect(
        await repeatPanel.locator('[style]').count(),
        'Repeat projection panel must not emit inline style attributes'
      ).toBe(0);

      const forEachPanel = page.getByTestId('foreach-node-projection-triage');
      await expect(forEachPanel).toBeVisible();
      await expect(page.getByTestId('foreach-item-counter-triage')).toContainText('Item 3 of 3');
      await expect(page.getByTestId('foreach-leaf-attempts-triage')).toContainText('6 leaf attempts');
      await expect(page.getByTestId('foreach-error-summary-triage')).toContainText('hasErrors: true');
      expect(
        await forEachPanel.locator('[style]').count(),
        'ForEach projection panel must not emit inline style attributes'
      ).toBe(0);

      // 4. Verify responsive viewports (360px, 720px, 1280px) without horizontal overflow
      for (const width of [360, 720, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        await expect(inspector).toBeVisible();
        const overflow = await inspector.evaluate((el) => {
          const htmlEl = el as unknown as {
            readonly scrollWidth: number;
            readonly clientWidth: number;
          };
          return htmlEl.scrollWidth > htmlEl.clientWidth;
        });
        expect(
          overflow,
          `CandidateBlockInspector must not overflow horizontally at ${width}px in ${theme}`
        ).toBe(false);
      }
    });
  }
});

/**
 * Findings 81 and 118 of the webview redesign review. The selected card's toolbar stands beside its
 * top-right corner, as the redesign draws it. The redesign draws no fork side by side, though, and
 * a fork's arms stand 16px apart, so beside a card with an arm to its right the toolbar covered
 * that arm's card: its kind icon and the start of its title. There the toolbar stands over the
 * card's top-right corner instead. On a touch screen its 44px buttons fill the arm above, so the
 * arms stand wider apart and the toolbar stands beside the card in a column.
 */
test.describe('the toolbar of a card in a fork', () => {
  interface Box {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
  }

  interface ToolbarLayout {
    readonly toolbar: Box;
    readonly card: Box;
    /** Every other card, button or chip on the canvas the toolbar overlaps. */
    readonly covered: readonly string[];
  }

  /** The fork fixture's Workflow: `triage` forks into `fix` (left) and `ship` (right). */
  const FORK_CARDS = { triage: 0, fix: 1, ship: 2 } as const;

  async function openForkWorkflow(page: Page): Promise<void> {
    await openControlDashboard(page, 'dark', 'waiting-availability');
    await page.getByTestId('dashboard-route-builder').click();
    await expect(page.getByTestId('pipeline-builder-root')).toBeVisible();
    await page.getByRole('tab', { name: 'Workflows' }).click();
    await page.getByTestId(`workflows-list-item-${POLICY_SMOKE_WORKFLOW_ID}`).click();
    await expect(page.getByTestId(`workflow-node-${FORK_CARDS.ship}`)).toBeVisible();
  }

  async function selectCard(page: Page, index: number): Promise<ToolbarLayout> {
    await page.getByTestId(`workflow-node-${index}`).click();
    await expect(page.getByTestId(`workflow-node-remove-${index}`)).toBeVisible();
    return (await page.evaluate(`(() => {
      const box = (el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      };
      const toolbar = document.querySelector('.canvas-wrap .wf-ntool');
      const t = box(toolbar);
      const covered = [...document.querySelectorAll('.canvas-wrap .wf-card, .canvas-wrap button, .canvas-wrap .elabel')]
        .filter((el) => !toolbar.contains(el))
        .filter((el) => {
          const b = box(el);
          return b.left < t.right && b.right > t.left && b.top < t.bottom && b.bottom > t.top;
        })
        .map((el) => el.getAttribute('aria-label') || el.textContent.trim().slice(0, 40));
      return { toolbar: t, card: box(toolbar.closest('.wf-card')), covered };
    })()`)) as ToolbarLayout;
  }

  test('stands where it covers no other card or control', async ({ page }) => {
    await openForkWorkflow(page);
    for (const [name, index] of Object.entries(FORK_CARDS)) {
      const { covered } = await selectCard(page, index);
      expect(covered, `the toolbar of ${name} covers nothing on the canvas`).toEqual([]);
    }

    // The redesign's place, beside the top-right corner, where no arm stands to the right...
    const beside = await selectCard(page, FORK_CARDS.ship);
    expect(beside.toolbar.left, 'beside the last arm').toBeGreaterThan(beside.card.right);
    expect(Math.abs(beside.toolbar.top - beside.card.top)).toBeLessThanOrEqual(1);
    // ...and over it where one does.
    const over = await selectCard(page, FORK_CARDS.fix);
    expect(over.toolbar.bottom, 'over an arm with an arm to its right').toBeLessThan(over.card.top);
    expect(Math.abs(over.toolbar.right - over.card.right)).toBeLessThanOrEqual(1);
  });

  test.describe('on a touch screen', () => {
    test.use({ hasTouch: true });

    test('stands beside the card in a column, the arms standing wider apart', async ({ page }) => {
      await openForkWorkflow(page);
      await expect.poll(() => page.evaluate("matchMedia('(pointer: coarse)').matches")).toBe(true);
      for (const [name, index] of Object.entries(FORK_CARDS)) {
        const { covered } = await selectCard(page, index);
        expect(covered, `the toolbar of ${name} covers nothing on the canvas`).toEqual([]);
      }

      const { toolbar, card } = await selectCard(page, FORK_CARDS.fix);
      expect(toolbar.left, 'beside the card').toBeGreaterThan(card.right);
      expect(toolbar.bottom - toolbar.top, 'a column').toBeGreaterThan(toolbar.right - toolbar.left);
    });
  });
});

