/**
 * Visual-fixture snapshot-schema parity.
 *
 * The Playwright visual suite publishes one hand-written snapshot,
 * `tests/visual/fixtures/workflow-snapshot.ts`, straight into the webview via
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
 *
 * FR-R3-021 — the fixture became a TypeScript module checked against the host
 * producer's `WorkflowSnapshot` with `satisfies`, so the compiler now rejects
 * most of what the shape checks below look for, and rejects it by name. These
 * stay for two reasons. They are a second formulation that does not depend on
 * the producer type being right — the typecheck can only be as good as the
 * interface, and typing the fixture is what exposed a field the interface had
 * omitted for four features. And they answer questions the type cannot phrase:
 * a `Record<string, unknown>` can be asked whether a key the contract does not
 * declare is nonetheless present, which is the shape a stale fixture takes.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { SCHEMA_VERSION } from '../../src/ui/sidebar/snapshot';
import { workflowSnapshot } from '../visual/fixtures/workflow-snapshot';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
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

/**
 * The fixture as an open record, so the checks below can ask about keys the
 * contract does not declare. A spread rather than a cast: the contract has been
 * wrong before, and a cast here would inherit whatever the next one gets wrong.
 */
function readFixture(): Record<string, unknown> {
  return { ...workflowSnapshot };
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

  it('the visual fixture keeps nothing the layer collapse removed', () => {
    // Feature 099 (T489a, FR-041, FR-043, FR-046) reshaped v4 in place rather than
    // bumping it: the number gates a fixture from a *different build*, and there is
    // no such thing — host and webview ship together. What the number cannot catch
    // is this, a same-version reshape, which is the whole reason this file exists.
    const fixture = readFixture();
    expect('phasePrecedence' in fixture, 'the precedence projection went with the layer tier').toBe(
      false
    );

    const trust = (fixture.resolvedTrust ?? {}) as Record<string, unknown>;
    expect(
      ['pipelineOverrides', 'workflowOverrides'].filter((key) => key in trust),
      'both capabilities went with the layer tier they gated'
    ).toEqual([]);
  });

  it('every catalog block the fixture carries is in the one-layer shape', () => {
    // A stale catalog block does not fail the store gate — it renders a Builder tab
    // with no revision to save under and rows keyed the old way, which is a green
    // visual suite screenshotting a surface no build produces.
    const fixture = readFixture();
    for (const block of ['phaseCatalog', 'pipelineCatalog', 'workflowCatalog'] as const) {
      const projection = fixture[block];
      if (projection === undefined) continue;
      const catalog = projection as Record<string, unknown>;
      expect(typeof catalog.revision, `${block}.revision`).toBe('string');
      expect('revisions' in catalog, `${block} still carries the per-layer revision map`).toBe(
        false
      );
      for (const record of (catalog.records ?? []) as readonly Record<string, unknown>[]) {
        expect('scope' in record, `${block}.records[] still carries a layer scope`).toBe(false);
      }
    }
  });
});
