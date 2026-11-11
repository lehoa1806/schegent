// FR-R6-F14 T019 — seeded markers never leave, and the attribute-set limit holds across batches
// (FR-006, FR-007, FR-008, NFR-006, NFR-007). Every marker is synthetic and built at call time:
// shaped like a credential, a path or a session identifier, and valid for nothing.
import { describe, expect, it } from 'vitest';
import { TELEMETRY_EXPORT_BOUNDS } from '../../../src/contracts/telemetry-export';
import { createHarness, settle, status, type Harness } from '../../fixtures/telemetry-export/exporter-harness';
import { mulberry32, pick } from '../../fixtures/seeded-rng';
import { correctionRecord, measure, operationRecord, usageRecord } from '../../fixtures/telemetry-export/source-records';

const ALPHABET = [...'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'];
const MARKER_PART_LENGTH = 12;

interface Markers {
  readonly token: string;
  readonly tokenFiller: string;
  readonly path: string;
  readonly session: string;
}

function markers(seed: number): Markers {
  const rng = mulberry32(seed);
  const tokenFiller = Array.from({ length: 40 }, () => pick(rng, ALPHABET)).join('');
  const sessionTail = Array.from({ length: 24 }, () => pick(rng, ALPHABET)).join('');
  return {
    token: `${['sk', '-ant-'].join('')}api03-${tokenFiller}`,
    tokenFiller,
    path: `/Users/marker-owner-${sessionTail.slice(0, 6)}/private-project/notes/plan.md`,
    session: `session-marker-${sessionTail}`
  };
}

/** Every text a marker must not appear in: the marker, and each part of it of 12 characters. */
function partsOf(marker: string): string[] {
  const parts = [marker];
  for (let start = 0; start + MARKER_PART_LENGTH <= marker.length; start += MARKER_PART_LENGTH) {
    parts.push(marker.slice(start, start + MARKER_PART_LENGTH));
  }
  return parts;
}

function seededRecords(seeded: Markers): unknown[] {
  const notExported = {
    prompt: `use ${seeded.token} to sign in`,
    cwd: seeded.path,
    workspaceRoot: seeded.path,
    sessionId: seeded.session,
    runId: seeded.session,
    errorMessage: `failed in ${seeded.path} with ${seeded.token}`
  };
  return [
    // Label fields that carry a path and a credential shape: each is left out and counted.
    { ...usageRecord({ sourceId: seeded.session, backend: seeded.path, modelRequested: seeded.token, modelReported: seeded.path }), ...notExported },
    { ...operationRecord({ sourceId: `${seeded.session}-attempt`, modelRequested: seeded.token, modelReported: null }), ...notExported },
    { ...correctionRecord({}, { sourceId: seeded.session, modelRequested: seeded.token }), ...notExported },
    // A control: ordinary labels that must arrive, so an empty request cannot pass the checks.
    { ...usageRecord({ sourceId: 'usage-control', measures: [measure({ quantity: '77' })] }), ...notExported }
  ];
}

/** Everything the exporter keeps or sends that a test can read. */
function everythingKept(harness: Harness): string {
  return JSON.stringify({
    requests: harness.transport.requests.map((request) => ({ url: request.url, headers: request.headers, text: request.text })),
    health: harness.exporter.health(),
    receipts: harness.ledger.receipts(),
    dispositions: harness.ledger.dispositions()
  });
}

interface WireAttribute {
  readonly key: string;
  readonly value: { readonly stringValue?: string; readonly boolValue?: boolean };
}
interface WirePoint {
  readonly attributes: readonly WireAttribute[];
  readonly count?: string;
  readonly sum?: number;
}
interface WireMetric {
  readonly name: string;
  readonly histogram?: { readonly dataPoints: readonly WirePoint[] };
}
interface WireRequest {
  readonly resourceMetrics: readonly { readonly scopeMetrics: readonly { readonly metrics: readonly WireMetric[] }[] }[];
}

function tokenUsagePoints(harness: Harness): WirePoint[] {
  return harness.transport.requests.flatMap((request) =>
    (JSON.parse(request.text) as WireRequest).resourceMetrics.flatMap((resource) =>
      resource.scopeMetrics.flatMap((scope) =>
        scope.metrics.filter((metric) => metric.name === 'gen_ai.client.token.usage').flatMap((metric) => metric.histogram?.dataPoints ?? [])
      )
    )
  );
}

function isOverflow(point: WirePoint): boolean {
  return point.attributes.some((attribute) => attribute.key === 'otel.metric.overflow' && attribute.value.boolValue === true);
}

function distinctModels(count: number, prefix: string): unknown[] {
  return Array.from({ length: count }, (_unused, index) => {
    const id = String(index).padStart(5, '0');
    return usageRecord({ sourceId: `${prefix}-${id}`, modelRequested: `model-${id}`, modelReported: null });
  });
}

describe('telemetry export privacy: seeded markers', () => {
  it.each([[313], [1_401], [90_210]])('keeps every marker of seed %i out of the request, health and the ledger', async (seed) => {
    const seeded = markers(seed);
    const records = seededRecords(seeded);
    const harness = createHarness();
    harness.authorize();
    // The first attempt fails, so a retry, two receipts and an error class are all in what is read.
    harness.transport.answer(status(503));
    expect(harness.exporter.offer(records)).toEqual({ accepted: 4, duplicate: 0, refused: 0 });
    harness.exporter.flush();
    await harness.time.advance(TELEMETRY_EXPORT_BOUNDS.retryBaseDelayMs);
    await settle();

    const offered = JSON.stringify(records);
    const kept = everythingKept(harness);
    for (const marker of [seeded.token, seeded.tokenFiller, seeded.path, seeded.session]) {
      expect(offered).toContain(marker);
      for (const part of partsOf(marker)) expect(kept.includes(part)).toBe(false);
    }
    expect(harness.transport.requests).toHaveLength(2);
    expect(harness.ledger.receipts()).toHaveLength(2);
    expect(kept).toContain('model-large-20260101');
    // The control record's value arrived, so an empty request cannot pass the checks above.
    expect(harness.transport.requests.at(0)?.text ?? '').toContain('"sum":77');
    expect(harness.exporter.health()).toMatchObject({ acknowledgedBatches: 1, invalidRecords: 0, lastError: null });
    // One for the backend and two for the models of the first record, one model for each of the next two.
    expect(harness.exporter.health().coverage['excluded-dimension']).toBe(5);
  });

  it('refuses a record whose source identity is not an identifier, and keeps nothing of it', async () => {
    const seeded = markers(7);
    const harness = createHarness();
    harness.authorize();
    const offered = harness.exporter.offer([usageRecord({ sourceId: seeded.path }), usageRecord({ sourceId: `id ${seeded.token}` })]);
    harness.exporter.flush();
    await settle();
    expect(offered).toEqual({ accepted: 0, duplicate: 0, refused: 2 });
    expect(harness.transport.requests).toHaveLength(0);
    expect(harness.exporter.health().invalidRecords).toBe(2);
    const kept = everythingKept(harness);
    for (const marker of [seeded.token, seeded.path]) {
      for (const part of partsOf(marker)) expect(kept.includes(part)).toBe(false);
    }
  });
});

describe('telemetry export cardinality: 1,001 label sets for one instrument', () => {
  const SETS_MAX = TELEMETRY_EXPORT_BOUNDS.attributeSetsMax;

  it('sends at most 1,000 sets, one of them the overflow set, and counts each fold', async () => {
    const harness = createHarness();
    harness.authorize();
    expect(harness.exporter.offer(distinctModels(SETS_MAX + 1, 'usage'))).toEqual({ accepted: SETS_MAX + 1, duplicate: 0, refused: 0 });
    harness.exporter.flush();
    await settle();

    const points = tokenUsagePoints(harness);
    const sets = new Set(points.map((point) => JSON.stringify(point.attributes)));
    const overflow = points.filter(isOverflow);
    expect(harness.transport.requests.length).toBeGreaterThan(1);
    expect(sets.size).toBe(SETS_MAX);
    expect(overflow).toHaveLength(1);
    expect(overflow.at(0)?.attributes).toEqual([{ key: 'otel.metric.overflow', value: { boolValue: true } }]);
    expect(overflow.at(0)?.count).toBe('2');
    expect(overflow.at(0)?.sum).toBe(2 * 1024);
    expect(harness.exporter.health().coverage).toMatchObject({ exported: SETS_MAX - 1, overflow: 2 });
    // No value is lost: every observation is in a data point, its own or the overflow one.
    expect(points.reduce((total, point) => total + Number(point.count ?? '0'), 0)).toBe(SETS_MAX + 1);
  });

  it('keeps a set admitted before the limit on its own data point after the limit', async () => {
    const harness = createHarness();
    harness.authorize();
    harness.exporter.offer(distinctModels(SETS_MAX + 1, 'usage'));
    harness.exporter.flush();
    await settle();
    const before = harness.transport.requests.length;

    harness.exporter.offer([
      usageRecord({ sourceId: 'again-00000', modelRequested: 'model-00000', modelReported: null }),
      usageRecord({ sourceId: 'again-new', modelRequested: 'model-never-seen', modelReported: null })
    ]);
    harness.exporter.flush();
    await settle();

    const last = harness.transport.requests.slice(before);
    expect(last).toHaveLength(1);
    const text = last.at(0)?.text ?? '';
    expect(text).toContain('model-00000');
    expect(text).not.toContain('model-never-seen');
    expect(text).toContain('otel.metric.overflow');
    expect(harness.exporter.health().coverage).toMatchObject({ exported: SETS_MAX, overflow: 3 });
  });

  it('holds the limit for each instrument on its own', async () => {
    const harness = createHarness();
    harness.authorize();
    harness.exporter.offer(distinctModels(SETS_MAX + 1, 'usage'));
    harness.exporter.offer([operationRecord({ sourceId: 'attempt-after-limit', modelRequested: 'model-of-an-attempt', modelReported: null })]);
    harness.exporter.flush();
    await settle();
    const text = harness.transport.requests.at(-1)?.text ?? '';
    expect(text).toContain('model-of-an-attempt');
  });
});
