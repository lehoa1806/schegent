/**
 * Visual-fixture snapshot-schema parity.
 *
 * The Playwright visual suite publishes one hand-written snapshot,
 * `tests/visual/fixtures/workflow-snapshot.json`, straight into the webview via
 * a `STATE_SNAPSHOT` message. The store drops any snapshot whose
 * `schemaVersion` it does not recognise, and a dropped snapshot leaves the
 * dashboard on "Connecting to workspace" — so every route-scoped
 * `getByTestId('dashboard-route-*')` times out after 30 s and 13 of the 16
 * visual tests fail for a reason that has nothing to do with pixels.
 *
 * That is exactly what feature 092's v3 → v4 reshape (FR-048) did: it moved the
 * root run singulars under `queues` and bumped `SCHEMA_VERSION`, and the fixture
 * stayed at 3. The failure mode is silent in the sense that matters — it is not
 * a diff to adjudicate, it is a suite that stopped covering anything.
 *
 * Four things must therefore agree on one number:
 *   1. the host producer, `src/ui/sidebar/snapshot.ts` (`SCHEMA_VERSION`);
 *   2. the webview mirror, `webview-ui/src/lib/snapshot-types.ts`;
 *   3. the store's accept gate in `webview-ui/src/lib/snapshot-store.svelte.ts`;
 *   4. the visual fixture.
 *
 * This runs under `npm run test`, so the next reshape fails in seconds rather
 * than as a 30 s-per-test Playwright timeout in `npm run test:visual`.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { SCHEMA_VERSION } from '../../src/ui/sidebar/snapshot';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURE_PATH = path.join(REPO_ROOT, 'tests', 'visual', 'fixtures', 'workflow-snapshot.json');
const STORE_PATH = path.join(
  REPO_ROOT,
  'webview-ui',
  'src',
  'lib',
  'snapshot-store.svelte.ts'
);

/** The v3 root singulars feature 092 folded under `queues[]`. */
const V3_ROOT_RUN_FIELDS = [
  'status',
  'activeFeature',
  'activePipeline',
  'activeRunId',
  'phases',
  'liveActivity',
  'workflowElapsedMs',
  'delayedRetry'
] as const;

function readFixture(): Record<string, unknown> {
  const parsed: unknown = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
  expect(typeof parsed).toBe('object');
  return parsed as Record<string, unknown>;
}

/**
 * The gate is a literal in the store rather than a reference to
 * `SCHEMA_VERSION`, so it is read from the source text. A regex that stops
 * matching fails this test rather than silently passing — the anchor going
 * stale is itself a finding.
 */
function readStoreGateVersion(): number {
  const source = fs.readFileSync(STORE_PATH, 'utf8');
  const match = /snap\.schemaVersion\s*!==\s*(\d+)/.exec(source);
  expect(
    match,
    'snapshot-store.svelte.ts no longer gates on `snap.schemaVersion !== <n>`; update this anchor'
  ).not.toBeNull();
  return Number((match as RegExpExecArray)[1]);
}

describe('visual fixture agrees with the snapshot schema the webview accepts', () => {
  it('host and webview SCHEMA_VERSION constants agree', async () => {
    const webview = await import('../../webview-ui/src/lib/snapshot-types.js');
    expect(webview.SCHEMA_VERSION).toBe(SCHEMA_VERSION);
  });

  it("the store's accept gate is the current SCHEMA_VERSION", () => {
    expect(readStoreGateVersion()).toBe(SCHEMA_VERSION);
  });

  it('the visual fixture carries the accepted schemaVersion', () => {
    expect(readFixture().schemaVersion).toBe(SCHEMA_VERSION);
  });

  it('the visual fixture publishes at least one queue runtime', () => {
    // A fixture with the right version but no queues passes the store gate and
    // still renders an idle dashboard, which would restore the suite to green
    // while covering none of the run-owning surfaces.
    const queues = readFixture().queues;
    expect(Array.isArray(queues)).toBe(true);
    expect((queues as readonly unknown[]).length).toBeGreaterThan(0);
  });

  it('the visual fixture keeps no v3 root run singulars', () => {
    const fixture = readFixture();
    const leftovers = V3_ROOT_RUN_FIELDS.filter((field) => field in fixture);
    expect(leftovers, 'these belong under queues[].inFlightRun / queues[]').toEqual([]);
  });
});
