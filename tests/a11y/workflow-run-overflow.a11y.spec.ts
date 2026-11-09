// Feature 265, BUG-001 (FR-008, SC-005) — every node of a long Workflow run is
// reachable in the run tier, by wheel and by keyboard.
//
// `workflow-control.a11y.spec.ts` mounts a one-node run, which cannot overflow,
// so it never saw the tier clip its own content. This fixture is the shipped
// `examples/speckit-new-feature.workflow.yaml` (eleven Phase nodes) with leaf
// Tasks whose `currentPipelineId` is the Phase id, as the host projects them.
//
// "Reachable" is measured, not assumed: a node counts once its whole box has
// been inside every clipping ancestor and the viewport at some scroll position.
// A clipped node can sit inside a scroller that never moves, which is exactly
// the defect, so a scroll offset alone proves nothing.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { ConnectedRunProjection } from '../../src/contracts/sidebar-ipc/workflow-run';
import type { WorkflowSnapshot } from '../../src/ui/sidebar/snapshot';
import { workflowSnapshot } from '../visual/fixtures/workflow-snapshot';

const EXAMPLE_WORKFLOW = resolve(__dirname, '../../examples/speckit-new-feature.workflow.yaml');
const EXPECTED_NODE_COUNT = 11;
const RUN_ID = 'cr-overflow';
const QUEUE_ID = 'default';
const STANDALONE_TASK_ID = 't-standalone';
const VIEWPORTS = [
  { width: 1440, height: 960 },
  { width: 1000, height: 600 }
] as const;
const MAX_SCROLL_STEPS = 40;
const WHEEL_DELTA_PX = 240;
const SETTLE_MS = 60;

function readNodeIds(): readonly string[] {
  const yaml = readFileSync(EXAMPLE_WORKFLOW, 'utf8');
  return [...yaml.matchAll(/^\s*- nodeId: (\S+)$/gm)].map((match) => match.at(1) ?? '');
}

function buildOverflowSnapshot(nodeIds: readonly string[]): WorkflowSnapshot {
  const [baseQueue] = workflowSnapshot.queues;
  const [taskTemplate] = baseQueue.tasks;
  const [first = '', second = '', live = ''] = nodeIds;
  const leafTask = (id: string, phaseId: string, position: number, status: 'failed' | 'completed' | 'in-flight') => ({
    ...taskTemplate,
    id,
    label: `Task: ${phaseId}`,
    position,
    status,
    currentPhase: status === 'in-flight' ? phaseId : null,
    currentPipelineId: phaseId,
    hasOnDiskLogs: true
  });
  const tasks = [
    leafTask('t-first-a1', first, 0, 'failed'),
    leafTask('t-first-a2', first, 1, 'completed'),
    leafTask('t-second', second, 2, 'completed'),
    leafTask('t-live', live, 3, 'in-flight'),
    { ...taskTemplate, id: STANDALONE_TASK_ID, label: 'Standalone Pipeline Task', position: 4, status: 'pending' as const, currentPhase: null, hasOnDiskLogs: false }
  ];
  const latest = new Map([
    [first, 't-first-a2'],
    [second, 't-second'],
    [live, 't-live']
  ]);
  const liveIndex = nodeIds.indexOf(live);
  const run: ConnectedRunProjection = {
    connectedRunId: RUN_ID,
    workflowId: 'speckit-new-feature',
    revision: 4,
    hydrating: false,
    queueId: QUEUE_ID,
    status: 'in-flight',
    rootInvocationId: 'inv-root',
    activeInvocationId: 'inv-root',
    nodes: nodeIds.map((nodeId, index) => {
      const latestQueueItemId = latest.get(nodeId);
      return {
        nodeId,
        pipelineId: nodeId,
        nodeKind: 'phase' as const,
        actions: [],
        state: index < liveIndex ? ('completed' as const) : index === liveIndex ? ('in-flight' as const) : ('unvisited' as const),
        attemptCount: nodeId === first ? 2 : latestQueueItemId === undefined ? 0 : 1,
        ...(latestQueueItemId === undefined ? {} : { latestQueueItemId })
      };
    }),
    invocations: [
      {
        invocationId: 'inv-root',
        parentInvocationId: null,
        workflowId: 'speckit-new-feature',
        workflowName: 'Spec-kit New Feature',
        depth: 0,
        nodePath: '',
        status: 'in-flight',
        currentNodeId: live,
        activeAttemptId: 'a4',
        activeAttemptIndex: 1,
        allowedActions: [],
        waitingReason: null,
        pauseCause: null,
        failureReason: null,
        pendingRetryAt: null,
        pendingRetryCause: null,
        outputPortIds: [],
        attempts: [
          { attemptId: 'a1', attemptIndex: 1, nodeId: first, nodeKind: 'phase', status: 'failed', startedAt: 1, endedAt: 2, queueItemId: 't-first-a1' },
          { attemptId: 'a2', attemptIndex: 2, nodeId: first, nodeKind: 'phase', status: 'completed', startedAt: 3, endedAt: 4, queueItemId: 't-first-a2' },
          { attemptId: 'a3', attemptIndex: 1, nodeId: second, nodeKind: 'phase', status: 'completed', startedAt: 5, endedAt: 6, queueItemId: 't-second' },
          { attemptId: 'a4', attemptIndex: 1, nodeId: live, nodeKind: 'phase', status: 'in-flight', startedAt: 7, queueItemId: 't-live' }
        ]
      }
    ]
  };
  return {
    ...workflowSnapshot,
    queues: [
      {
        ...baseQueue,
        inFlightRun: { ...baseQueue.inFlightRun, feature: { ...baseQueue.inFlightRun.feature, id: 't-live' } },
        tasks
      }
    ],
    connectedRuns: [run]
  };
}

async function openOverflowRun(page: Page, viewport: { readonly width: number; readonly height: number }, snapshot: WorkflowSnapshot): Promise<void> {
  await page.setViewportSize(viewport);
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === 'http://127.0.0.1:4173') {
      await route.continue();
      return;
    }
    await route.fulfill({ status: 200, contentType: 'text/css', body: '' });
  });
  await page.goto('/dashboard.html');
  await page.evaluate((payload) => {
    const host = globalThis as unknown as { dispatchEvent(event: unknown): boolean };
    host.dispatchEvent(new MessageEvent('message', { data: { type: 'STATE_SNAPSHOT', payload } }));
  }, JSON.parse(JSON.stringify(snapshot)) as unknown);
  await page.getByTestId('dashboard-route-operations').click();
  await page.getByTestId(`queue-card-${QUEUE_ID}`).click();
  await page.getByTestId('queue-detail-tier').waitFor();
}

// String form, like `runScopedAxe`: the test tsconfig carries no DOM lib.
function fullyVisibleNodesScript(nodeIds: readonly string[]): string {
  return `(() => {
    const ids = ${JSON.stringify(nodeIds)};
    const visible = [];
    for (const id of ids) {
      const node = document.querySelector('[data-testid="workflow-node-' + id + '"]');
      if (node === null) continue;
      const box = node.getBoundingClientRect();
      let top = 0, bottom = window.innerHeight;
      for (let el = node.parentElement; el !== null; el = el.parentElement) {
        const overflowY = getComputedStyle(el).overflowY;
        if (overflowY === 'visible') continue;
        const clip = el.getBoundingClientRect();
        top = Math.max(top, clip.top);
        bottom = Math.min(bottom, clip.bottom);
      }
      if (box.height > 0 && box.top >= top - 1 && box.bottom <= bottom + 1) visible.push(id);
    }
    return visible;
  })()`;
}

async function collectReachable(page: Page, nodeIds: readonly string[], step: () => Promise<void>): Promise<readonly string[]> {
  const seen = new Set<string>();
  for (let index = 0; index < MAX_SCROLL_STEPS && seen.size < nodeIds.length; index += 1) {
    for (const id of (await page.evaluate(fullyVisibleNodesScript(nodeIds))) as string[]) seen.add(id);
    await step();
    await page.waitForTimeout(SETTLE_MS);
  }
  return nodeIds.filter((id) => seen.has(id));
}

test.describe('Feature 265 BUG-001 — a long Workflow run is reachable in the run tier', () => {
  const nodeIds = readNodeIds();
  const snapshot = buildOverflowSnapshot(nodeIds);

  test('the fixture is the eleven-node example Workflow', () => {
    expect(nodeIds).toHaveLength(EXPECTED_NODE_COUNT);
  });

  for (const viewport of VIEWPORTS) {
    test(`every node is reachable by wheel at ${viewport.width}x${viewport.height}`, async ({ page }) => {
      await openOverflowRun(page, viewport, snapshot);
      await page.getByTestId(`queue-run-row-${RUN_ID}`).click();
      await page.getByTestId('workflow-run').waitFor();
      const box = await page.getByTestId('workflow-run').boundingBox();
      await page.mouse.move(viewport.width / 2, Math.min(viewport.height - 20, (box?.y ?? 0) + 40));
      const reached = await collectReachable(page, nodeIds, async () => {
        await page.mouse.wheel(0, WHEEL_DELTA_PX);
      });
      expect(reached).toEqual(nodeIds);
    });

    test(`every node is reachable by keyboard from Back at ${viewport.width}x${viewport.height}`, async ({ page }) => {
      await openOverflowRun(page, viewport, snapshot);
      await page.getByTestId(`queue-run-row-${RUN_ID}`).click();
      await page.getByTestId('workflow-run').waitFor();
      await page.getByTestId('run-detail-back').focus();
      const reached = await collectReachable(page, nodeIds, async () => {
        await page.keyboard.press('PageDown');
      });
      expect(reached).toEqual(nodeIds);
      await expect(page.getByTestId('run-detail-back')).toBeFocused();
    });
  }

  test('the Task branch of the run tier stays bounded by the scroller', async ({ page }) => {
    await openOverflowRun(page, { width: 1440, height: 960 }, snapshot);
    await page.getByTestId(`queue-task-row-${STANDALONE_TASK_ID}`).click();
    await page.getByTestId('run-detail-tier').waitFor();
    const bounds = (await page.evaluate(`(() => {
      const tier = document.querySelector('[data-testid="run-detail-tier"]');
      const scroller = document.querySelector('[data-testid="operations-scroll"]');
      return {
        overflowY: getComputedStyle(tier).overflowY,
        tierHeight: Math.round(tier.getBoundingClientRect().height),
        scrollerHeight: scroller.clientHeight
      };
    })()`)) as { overflowY: string; tierHeight: number; scrollerHeight: number };
    expect(bounds.overflowY).toBe('hidden');
    expect(bounds.tierHeight).toBeLessThanOrEqual(bounds.scrollerHeight);
  });
});
