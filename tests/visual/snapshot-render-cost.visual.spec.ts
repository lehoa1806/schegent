// Webview render cost per named workload (FR-R4-F08, contract E: E4, E5; E-T3; research R23).
//
// WHAT THIS RECORDS. How long the built dashboard takes to apply a state snapshot, from the moment
// the `message` event is dispatched to the second `requestAnimationFrame` after it, in Chromium, for
// four payloads: idle, active, large-history and large-history-2x
// (`fixtures/cost-workloads.ts`). Each prints one `RENDER_COST <json>` line carrying the payload's
// own UTF-8 bytes, so a reader can compare them with the host's `SNAPSHOT_COST` lines.
//
// A MEASUREMENT, NOT A BUDGET (E5). It asserts what each workload holds (the History route's own
// "N of M runs" count and the number of History rows in the DOM) and that each distribution has its
// sample count. It asserts no timing, so it cannot flake the gate, and `tests/perf/budgets.json` gets
// no entry. Distributions are 200 samples after 20 warm-up samples (FR-015).
//
// WHERE. The History route is open throughout, because its rows are what scales with history. That
// route renders at most 200 rows however many entries the snapshot holds, so the large workloads
// measure the cost of applying a larger payload, not of drawing more rows; the record says so.
//
// HERMETIC (standing rule 16). It uses no `addStyleTag` and no `addScriptTag`, and aborts every
// request outside `http://127.0.0.1:4173`, asserting the count is zero. Each sample dispatches a
// fresh structured clone of the payload with a later `producedAt`, so the store sees a new snapshot
// each time and the clone is made outside the timed region.

import { expect, test, type Page } from '@playwright/test';
import { COST_WORKLOADS, type CostWorkload } from './fixtures/cost-workloads';

const ORIGIN = 'http://127.0.0.1:4173';
const SAMPLES = 200;
const WARM_UP_SAMPLES = 20;
const VIEWPORT = { width: 1440, height: 960 } as const;
const WORKLOAD_TIMEOUT_MS = 240_000;
const MOUNT_TIMEOUT_MS = 10_000;

interface Distribution {
  readonly samples: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

function distributionOf(values: readonly number[]): Distribution {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (fraction: number): number => sorted.at(Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))) ?? 0;
  return { samples: sorted.length, p50: at(0.5), p95: at(0.95), max: sorted.at(-1) ?? 0 };
}

/** The fake host API, as the visual suite's deterministic host installs it. */
const INIT_SCRIPT = `(() => {
  let persistedState;
  const emit = (data) => window.dispatchEvent(new MessageEvent('message', { data }));
  const api = {
    postMessage(message) {
      if (!message || typeof message !== 'object') return;
      if (typeof message.correlationId !== 'string') return;
      window.setTimeout(() => emit({ type: 'CMD_ACK', correlationId: message.correlationId, status: 'accepted' }), 0);
    },
    setState(state) { persistedState = state; },
    getState() { return persistedState; }
  };
  Object.defineProperty(window, 'acquireVsCodeApi', { configurable: false, enumerable: false, value: () => api });
})();`;

async function openDashboard(page: Page, aborted: string[]): Promise<void> {
  await page.setViewportSize(VIEWPORT);
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === ORIGIN) {
      await route.continue();
      return;
    }
    aborted.push(url.href);
    await route.abort();
  });
  await page.addInitScript({ content: INIT_SCRIPT });
  await page.goto('/dashboard.html');
}

async function publish(page: Page, snapshot: unknown): Promise<void> {
  await page.evaluate((payload) => {
    const host = globalThis as unknown as { dispatchEvent(event: unknown): boolean };
    host.dispatchEvent(new MessageEvent('message', { data: { type: 'STATE_SNAPSHOT', payload } }));
  }, JSON.parse(JSON.stringify(snapshot)) as unknown);
}

/** Dispatch a fresh clone of the stored payload and resolve with the time to the second frame after it. */
async function sampleOnce(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const host = globalThis as unknown as {
          __costPayload: { producedAt: string };
          __costSample: number;
          structuredClone<T>(value: T): T;
          dispatchEvent(event: unknown): boolean;
          requestAnimationFrame(callback: () => void): number;
          performance: { now(): number };
        };
        const payload = host.structuredClone(host.__costPayload);
        host.__costSample += 1;
        payload.producedAt = new Date(Date.parse(payload.producedAt) + host.__costSample * 1_000).toISOString();
        const start = host.performance.now();
        host.dispatchEvent(new MessageEvent('message', { data: { type: 'STATE_SNAPSHOT', payload } }));
        host.requestAnimationFrame(() => host.requestAnimationFrame(() => resolve(host.performance.now() - start)));
      })
  );
}

async function measureWorkload(page: Page, workload: CostWorkload): Promise<void> {
  const aborted: string[] = [];
  await openDashboard(page, aborted);
  // Mount on an idle snapshot, then open the History route, whose rows are what scale with history.
  const idle = COST_WORKLOADS.find((candidate) => candidate.name === 'idle');
  if (idle === undefined) throw new Error('the idle workload is missing');
  await publish(page, idle.snapshot);
  await page.getByTestId('dashboard-route-history').click();
  await expect(page.getByTestId('history-dashboard'), 'the History route must mount').toBeVisible({ timeout: MOUNT_TIMEOUT_MS });

  await page.evaluate((payload) => {
    const host = globalThis as unknown as { __costPayload: unknown; __costSample: number };
    host.__costPayload = payload;
    host.__costSample = 0;
  }, JSON.parse(JSON.stringify(workload.snapshot)) as unknown);

  const values: number[] = [];
  for (let sample = 0; sample < WARM_UP_SAMPLES + SAMPLES; sample += 1) {
    const elapsed = await sampleOnce(page);
    if (sample >= WARM_UP_SAMPLES) values.push(elapsed);
  }

  // What the workload holds, read from the route's own words and the DOM, never from the fixture alone.
  const countText = (await page.getByTestId('history-render-count').innerText()).replace(/\s+/g, ' ').trim();
  const rows = await page.locator('[data-testid^="history-entry-"]').count();
  const browser = page.context().browser();
  const line = {
    workload: workload.name,
    environment: {
      os: process.platform,
      arch: process.arch,
      node: process.version,
      browser: browser === null ? 'unknown' : `chromium ${browser.version()}`
    },
    payloadBytes: Buffer.byteLength(JSON.stringify(workload.snapshot), 'utf8'),
    fixture: {
      queues: workload.queues,
      historyEntries: workload.historyEntries,
      auditTail: workload.auditTail,
      debugTail: workload.debugTail
    },
    historyRowsInDom: rows,
    historyCountText: countText,
    applyToFrameMs: distributionOf(values)
  };
  process.stdout.write(`RENDER_COST ${JSON.stringify(line)}\n`);

  expect(countText, `${workload.name}: the History route's own count`).toBe(
    `${workload.expectedHistoryRows} of ${workload.expectedMatched} ${workload.expectedMatched === 1 ? 'run' : 'runs'}`
  );
  expect(rows, `${workload.name}: History rows in the DOM`).toBe(workload.expectedHistoryRows);
  expect(line.applyToFrameMs.samples, `${workload.name}: apply-to-frame samples`).toBe(SAMPLES);
  expect(aborted, 'requests outside the local server').toEqual([]);
}

test.describe('snapshot render cost', () => {
  for (const workload of COST_WORKLOADS) {
    test(`E-T3 ${workload.name}: apply to the second frame`, async ({ page }) => {
      test.setTimeout(WORKLOAD_TIMEOUT_MS);
      await measureWorkload(page, workload);
    });
  }
});
