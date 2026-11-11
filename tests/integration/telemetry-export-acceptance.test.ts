// FR-R6-F14 T028 — the telemetry export acceptance rows (spec acceptance matrix), on the real
// OTLP/HTTP JSON transport against the synthetic loopback collector. The exporter's clock, timers
// and random are the harness fakes, so a retry delay is moved by the test; the transport does
// real loopback I/O and keeps its own 2 s deadline.
//
// WHAT THIS PINS:
//   - AC-01: with nothing configured, no profile, a disabled profile or a refused profile the
//     collector sees zero connections and the secret port zero reads; an authorized profile sends;
//   - AC-02: the versioned fixture arrives as exactly the pinned request; an estimate, a missing
//     value and a correction stay distinct on the wire;
//   - AC-03: after a lost acknowledgement the retry carries the same bytes under the same batch
//     identity, a re-offer is all duplicates, and the offered records are unchanged;
//   - AC-04: seeded markers never reach the collector; 1,001 label sets arrive as 1,000 sets with
//     one explicit overflow set; a content profile is refused;
//   - AC-05: a destination that keeps failing ends in a counted expiry after six attempts; a
//     rejection and a redirect are dropped and counted and the redirect target sees nothing; a
//     silent destination meets the 2 s deadline; the memory queue stays inside its bound;
//   - AC-06: shutdown with a request in flight ends inside 250 ms and gives every batch a
//     disposition; disable does the same and a later destination gets none of the dropped data;
//   - AC-07: the exporter and its contract reach no editor module through any import;
//   - AC-08: the exporter creates no server and no listener;
//   - AC-09: a response changes delivery fields only; the process environment is untouched;
//   - AC-10: an acknowledgement writes one receipt and one disposition and no other ledger fact.
//
// Deferred to F14-B: the disk spool, the SQLite ledger, the settings surface, the secret-store
// adapter and activation wiring. The mapping latency bound (AC-05, NFR-003) is the perf tier.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  TELEMETRY_EXPORT_BOUNDS,
  type ProfileEvaluation,
  type ProfileEvaluationContext,
  type TelemetryExporter,
  type TelemetryLedgerPort,
  type TelemetryProfile
} from '../../src/contracts/telemetry-export';
import { createInMemoryLedger, createOtlpHttpTransport, evaluateProfiles } from '../../src/services/telemetry-export/index';
import { mulberry32, pick } from '../fixtures/seeded-rng';
import {
  SYNTHETIC_CREDENTIAL,
  SYNTHETIC_HEADER,
  SYNTHETIC_REFERENCE,
  createHarness,
  settle,
  type Harness,
  type HarnessOptions
} from '../fixtures/telemetry-export/exporter-harness';
import { startFixtureCollector, type CollectorScenario, type FixtureCollector } from '../fixtures/telemetry-export/fixture-collector';
import expectedRequest from '../fixtures/telemetry-export/mapping-1.expected-request.json';
import { cost, measure, usageRecord } from '../fixtures/telemetry-export/source-records';
import sourceRecords from '../fixtures/telemetry-export/source-schema-1.records.json';
import { waitForCondition } from '../wait-for-condition';

const BOUNDS = TELEMETRY_EXPORT_BOUNDS;
const WAIT_MS = 20_000;
const SERVICE_VERSION = '0.2.0';
const FIXTURE_RECORDS: readonly unknown[] = sourceRecords;
const TRUSTED: ProfileEvaluationContext = { workspaceTrusted: true, secretStore: 'available' };
const NONE = { accepted: 0, duplicate: 0, refused: 0 };

const SOURCE_ROOT = resolve(__dirname, '..', '..', 'src');
const EXPORTER_DIR = resolve(SOURCE_ROOT, 'services', 'telemetry-export');
const EXPORTER_ENTRY = resolve(EXPORTER_DIR, 'index.ts');
const CONTRACT = resolve(SOURCE_ROOT, 'contracts', 'telemetry-export.ts');
const EDITOR_ENTRY = resolve(SOURCE_ROOT, 'extension.ts');
const ENVIRONMENT_READER = resolve(SOURCE_ROOT, 'runner', 'spawn-env.ts');
const COLLECTOR_SOURCE = resolve(__dirname, '..', 'fixtures', 'telemetry-export', 'fixture-collector.ts');

const RELATIVE_IMPORT = /from '(\.{1,2}\/[^']+)'/g;
const OUTSIDE_IMPORT = /from '([^.'][^']*)'/g;
const EDITOR_IMPORT = /from 'vscode'/;
const SERVER_NEEDLES = ['createServer', '.listen('] as const;

interface WirePoint {
  readonly attributes: readonly { readonly key: string; readonly value: Readonly<Record<string, unknown>> }[];
  readonly count?: string;
  readonly sum?: number;
  readonly asInt?: string;
}
interface WireMetric {
  readonly name: string;
  readonly unit: string;
  readonly sum?: { readonly dataPoints: readonly WirePoint[] };
  readonly histogram?: { readonly dataPoints: readonly WirePoint[] };
}
interface WireRequest {
  readonly resourceMetrics: readonly { readonly scopeMetrics: readonly { readonly metrics: readonly WireMetric[] }[] }[];
}

const collectors: FixtureCollector[] = [];
const exporters: TelemetryExporter[] = [];

afterEach(async () => {
  await Promise.all(exporters.splice(0).map((exporter) => exporter.shutdown()));
  await Promise.all(collectors.splice(0).map((collector) => collector.close()));
});

async function startCollector(...scenarios: readonly CollectorScenario[]): Promise<FixtureCollector> {
  const collector = await startFixtureCollector();
  collectors.push(collector);
  collector.respondWith(...scenarios);
  return collector;
}

/** The exporter on the real transport, with the harness clock, timers, random, secrets and ledger. */
function startExporter(options: HarnessOptions = {}): Harness {
  const harness = createHarness({ ...options, transport: createOtlpHttpTransport() });
  exporters.push(harness.exporter);
  return harness;
}

function profile(endpoint: string, overrides: Partial<TelemetryProfile> = {}): TelemetryProfile {
  return {
    id: 'acceptance-collector',
    revision: 1,
    enabled: true,
    scope: 'user',
    protocol: 'otlp-http-json',
    signals: ['metrics'],
    contentPolicy: 'metadata-only',
    endpoint,
    allowPlaintextLoopback: true,
    credential: { reference: SYNTHETIC_REFERENCE, headerName: SYNTHETIC_HEADER },
    ...overrides
  };
}

/** Puts the collector in force through the profile rules, as a host would. */
function authorize(harness: Harness, collector: FixtureCollector, generation = 1): void {
  const evaluation = evaluateProfiles([profile(collector.url)], TRUSTED);
  expect(evaluation.kind).toBe('authorized');
  harness.exporter.configure(evaluation, generation);
}

function nth<T>(items: readonly T[], index: number): T {
  const item = items.at(index);
  if (item === undefined) throw new Error(`no item at ${String(index)} of ${String(items.length)}`);
  return item;
}

async function receipts(harness: Harness, count: number): Promise<void> {
  await waitForCondition(() => harness.ledger.receipts().length >= count, { timeoutMs: WAIT_MS, label: `${String(count)} delivery receipts` });
}

async function dispositions(harness: Harness, count: number): Promise<void> {
  await waitForCondition(() => harness.ledger.dispositions().length >= count, {
    timeoutMs: WAIT_MS,
    label: `${String(count)} batch dispositions`
  });
}

function wireOf(body: Buffer): WireRequest {
  return JSON.parse(body.toString('utf8')) as WireRequest;
}

function metricsOf(request: WireRequest): readonly WireMetric[] {
  return request.resourceMetrics.flatMap((resource) => resource.scopeMetrics.flatMap((scope) => scope.metrics));
}

function pointsOf(request: WireRequest, name: string): readonly WirePoint[] {
  return metricsOf(request)
    .filter((metric) => metric.name === name)
    .flatMap((metric) => [...(metric.sum?.dataPoints ?? []), ...(metric.histogram?.dataPoints ?? [])]);
}

function labelValues(request: WireRequest, name: string, key: string): string[] {
  const values = pointsOf(request, name).flatMap((point) =>
    point.attributes.filter((attribute) => attribute.key === key).map((attribute) => String(attribute.value.stringValue))
  );
  return [...new Set(values)].sort();
}

/** Everything the collector received, as one text: paths, header names and values, bodies. */
function everythingReceived(collector: FixtureCollector): string {
  return collector.requests.map((request) => `${request.path}\n${JSON.stringify(request.headers)}\n${request.body.toString('utf8')}`).join('\n');
}

function digestOfEnvironment(): string {
  return createHash('sha256').update(JSON.stringify(process.env)).digest('hex');
}

const MARKER_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'.split('');

function filler(rng: () => number, length: number): string {
  return Array.from({ length }, () => pick(rng, MARKER_ALPHABET)).join('');
}

/** Synthetic markers built at call time: shaped like a credential, a path and a session id. */
function markers(seed: number): { token: string; path: string; session: string } {
  const rng = mulberry32(seed);
  return {
    token: `${['sk', '-ant-'].join('')}api03-${filler(rng, 40)}`,
    path: `/Users/marker-owner-${filler(rng, 6)}/private-project/notes/plan.md`,
    session: `session-marker-${filler(rng, 24)}`
  };
}

function distinctModels(count: number): unknown[] {
  return Array.from({ length: count }, (_unused, index) => {
    const id = String(index).padStart(5, '0');
    return usageRecord({ sourceId: `sets-${id}`, modelRequested: `model-${id}`, modelReported: null });
  });
}

/** A full batch whose records each carry five measures and a model pair of their own. */
function heavyRecords(round: number): unknown[] {
  return Array.from({ length: BOUNDS.batchRecordsMax }, (_unused, index) =>
    usageRecord({
      sourceId: `heavy-${String(round)}-${String(index)}`,
      modelRequested: `model-${String(index)}`,
      modelReported: `model-${String(index)}-20260101`,
      measures: [
        measure(),
        measure({ measure: 'output_tokens', quantity: '64' }),
        measure({ measure: 'cache_read_tokens', quantity: '32', cacheRelation: 'subset-of-input' }),
        measure({ measure: 'cache_creation_tokens', quantity: '16', cacheRelation: 'disjoint' }),
        cost('1500')
      ]
    })
  );
}

function sendOne(harness: Harness, sourceId: string): void {
  expect(harness.exporter.offer([usageRecord({ sourceId })])).toEqual({ ...NONE, accepted: 1 });
  harness.exporter.flush();
}

/** Every file reached from the entries through relative imports, with its text. */
function importClosure(entries: readonly string[]): ReadonlyMap<string, string> {
  const seen = new Map<string, string>();
  const pending = [...entries];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (seen.has(file)) continue;
    const text = readFileSync(file, 'utf8');
    seen.set(file, text);
    for (const match of text.matchAll(RELATIVE_IMPORT)) {
      const base = resolve(dirname(file), match.at(1) ?? '');
      const asFile = `${base}.ts`;
      pending.push(existsSync(asFile) ? asFile : resolve(base, 'index.ts'));
    }
  }
  return seen;
}

function exporterSources(): readonly { readonly name: string; readonly text: string }[] {
  return readdirSync(EXPORTER_DIR)
    .filter((name) => name.endsWith('.ts'))
    .sort()
    .map((name) => ({ name, text: readFileSync(resolve(EXPORTER_DIR, name), 'utf8') }));
}

describe('F14-AC-01 disabled and opt-in', () => {
  it('opens no connection and reads no secret until an authorized profile is in force, then sends', { timeout: WAIT_MS }, async () => {
    const collector = await startCollector();
    const harness = startExporter();
    const notInForce: readonly (readonly [string, ProfileEvaluation | null, string])[] = [
      ['nothing configured', null, 'none'],
      ['no profile', evaluateProfiles([], TRUSTED), 'disabled'],
      ['a disabled profile', evaluateProfiles([profile(collector.url, { enabled: false })], TRUSTED), 'disabled'],
      ['a workspace-scope profile', evaluateProfiles([profile(collector.url, { scope: 'workspace' })], TRUSTED), 'scope-not-authorized'],
      [
        'an untrusted workspace',
        evaluateProfiles([profile(collector.url)], { workspaceTrusted: false, secretStore: 'available' }),
        'workspace-untrusted'
      ],
      [
        'no secret store',
        evaluateProfiles([profile(collector.url)], { workspaceTrusted: true, secretStore: 'absent' }),
        'secret-store-unavailable'
      ]
    ];
    let generation = 0;
    for (const [label, evaluation, expected] of notInForce) {
      generation += 1;
      const outcome = evaluation === null ? 'none' : evaluation.kind === 'refused' ? evaluation.reason : evaluation.kind;
      expect(outcome, label).toBe(expected);
      if (evaluation !== null) harness.exporter.configure(evaluation, generation);
      const offered = harness.exporter.offer([usageRecord({ sourceId: `not-in-force-${String(generation)}` })]);
      harness.exporter.flush();
      await settle();
      expect(offered, label).toEqual({ ...NONE, refused: 1 });
      expect(harness.exporter.health().state, label).toBe('disabled');
    }
    expect(harness.exporter.health()).toMatchObject({ refusedOffers: notInForce.length, queuedBatches: 0, droppedBatches: 0 });
    expect(harness.secrets.reads()).toBe(0);
    expect(collector.connections()).toBe(0);

    authorize(harness, collector, generation + 1);
    sendOne(harness, 'in-force-1');
    await receipts(harness, 1);
    // Every connection the collector ever saw belongs to the one authorized request.
    expect(collector.connections()).toBe(1);
    expect(collector.requests).toHaveLength(1);
    const request = nth(collector.requests, 0);
    expect(request.method).toBe('POST');
    expect(request.path).toBe('/v1/metrics');
    expect(request.headers['content-type']).toBe('application/json');
    expect(request.headers[SYNTHETIC_HEADER]).toBe(SYNTHETIC_CREDENTIAL);
    expect(harness.secrets.reads()).toBe(1);
    expect(harness.exporter.health()).toMatchObject({ state: 'healthy', acknowledgedBatches: 1 });
  });
});

describe('F14-AC-02 mapping and usage quality', () => {
  it('delivers the versioned fixture as exactly the pinned request', { timeout: WAIT_MS }, async () => {
    const collector = await startCollector();
    const harness = startExporter({ serviceVersion: SERVICE_VERSION });
    authorize(harness, collector);
    expect(harness.exporter.offer(FIXTURE_RECORDS)).toEqual({ ...NONE, accepted: FIXTURE_RECORDS.length });
    harness.exporter.flush();
    await receipts(harness, 1);

    expect(collector.requests).toHaveLength(1);
    const body = nth(collector.requests, 0).body;
    expect(body.toString('utf8')).toBe(JSON.stringify(expectedRequest));
    expect(nth(collector.requests, 0).headers['content-length']).toBe(String(body.byteLength));

    const wire = wireOf(body);
    // An estimate keeps its provenance, a partial value its completeness.
    expect(labelValues(wire, 'gen_ai.client.token.usage', 'schegent.usage.provenance')).toContain('estimated');
    expect(labelValues(wire, 'gen_ai.client.token.usage', 'schegent.usage.completeness')).toEqual(['known', 'partial']);
    expect(labelValues(wire, 'schegent.usage.cost', 'schegent.usage.provenance')).toEqual(['derived', 'estimated']);
    // A missing value is counted as missing; it is not a zero on a usage instrument.
    const coverage = pointsOf(wire, 'schegent.export.coverage').map((point) => [
      String(nth(point.attributes, 0).value.stringValue),
      point.asInt
    ]);
    expect(coverage).toContainEqual(['missing', '2']);
    expect(coverage).toContainEqual(['correction', '2']);
    // A correction goes to an adjustment instrument and to no usage instrument.
    expect(pointsOf(wire, 'schegent.usage.token_adjustment').length).toBeGreaterThan(0);
    expect(labelValues(wire, 'gen_ai.client.token.usage', 'schegent.usage.measure')).toEqual([]);
    expect(labelValues(wire, 'schegent.usage.token_adjustment', 'schegent.usage.measure').length).toBeGreaterThan(0);
  });
});

describe('F14-AC-03 duplicated exports', () => {
  it('retries a lost acknowledgement with the same bytes and sends nothing twice', { timeout: WAIT_MS }, async () => {
    const collector = await startCollector({ kind: 'drops-after-body' }, { kind: 'ok' });
    const harness = startExporter();
    authorize(harness, collector);
    const records = [usageRecord({ sourceId: 'lost-ack-1' }), usageRecord({ sourceId: 'lost-ack-2', measures: [cost('2500')] })];
    const before = JSON.stringify(records);
    expect(harness.exporter.offer(records)).toEqual({ ...NONE, accepted: 2 });
    harness.exporter.flush();
    await receipts(harness, 1);
    expect(harness.exporter.health().state).toBe('retrying');
    await harness.time.advance(BOUNDS.retryBaseDelayMs);
    await receipts(harness, 2);

    expect(collector.requests).toHaveLength(2);
    expect(nth(collector.requests, 0).body.equals(nth(collector.requests, 1).body)).toBe(true);
    const [lost, acknowledged] = [nth(harness.ledger.receipts(), 0), nth(harness.ledger.receipts(), 1)];
    expect([lost.outcome, lost.errorClass, lost.statusCode]).toEqual(['retry', 'network', null]);
    expect([acknowledged.outcome, acknowledged.errorClass, acknowledged.statusCode]).toEqual(['acknowledged', null, 200]);
    expect(acknowledged.batchId).toBe(lost.batchId);
    expect(acknowledged.attemptId).not.toBe(lost.attemptId);
    expect(harness.ledger.dispositions()).toEqual([{ batchId: lost.batchId, state: 'acknowledged', reason: null }]);

    // The same records again: every one is a duplicate and nothing is queued for them.
    const exportedBefore = harness.exporter.health().coverage.exported;
    expect(harness.exporter.offer(records)).toEqual({ ...NONE, duplicate: 2 });
    harness.exporter.flush();
    expect(harness.exporter.health()).toMatchObject({ duplicateRecords: 2, queuedBatches: 0 });
    expect(harness.exporter.health().coverage.exported).toBe(exportedBefore);
    // A new record is the third request, and it carries only itself.
    sendOne(harness, 'lost-ack-3');
    await receipts(harness, 3);
    expect(collector.requests).toHaveLength(3);
    const tokenPoints = pointsOf(wireOf(nth(collector.requests, 2).body), 'gen_ai.client.token.usage');
    expect(tokenPoints.map((point) => point.count)).toEqual(['1']);
    expect(pointsOf(wireOf(nth(collector.requests, 2).body), 'schegent.usage.cost')).toEqual([]);
    expect(JSON.stringify(records)).toBe(before);
  });
});

describe('F14-AC-04 privacy and cardinality', () => {
  it('keeps seeded markers away from the collector', { timeout: WAIT_MS }, async () => {
    const collector = await startCollector();
    const harness = startExporter();
    authorize(harness, collector);
    const seeded = markers(313);
    const records = [
      {
        ...usageRecord({ sourceId: 'marked-1', backend: seeded.path, modelRequested: seeded.token, modelReported: seeded.path }),
        prompt: `summarise ${seeded.path}`,
        cwd: seeded.path,
        sessionId: seeded.session,
        errorMessage: `failed with ${seeded.token}`
      },
      usageRecord({ sourceId: 'marked-control', measures: [measure({ quantity: '77' })] })
    ];
    expect(harness.exporter.offer(records)).toEqual({ ...NONE, accepted: 2 });
    harness.exporter.flush();
    await receipts(harness, 1);

    const offered = JSON.stringify(records);
    const received = everythingReceived(collector);
    for (const marker of [seeded.token, seeded.path, seeded.session]) {
      expect(offered).toContain(marker);
      expect(received.includes(marker)).toBe(false);
      expect(received.includes(marker.slice(-12))).toBe(false);
    }
    // The control record's value arrived, so an empty request cannot pass the checks above.
    expect(received).toContain('"sum":77');
    expect(harness.exporter.health().coverage['excluded-dimension']).toBe(3);
  });

  it('sends 1,001 label sets as 1,000 sets with one explicit overflow set', { timeout: WAIT_MS }, async () => {
    const collector = await startCollector();
    const harness = startExporter();
    authorize(harness, collector);
    const total = BOUNDS.attributeSetsMax + 1;
    expect(harness.exporter.offer(distinctModels(total))).toEqual({ ...NONE, accepted: total });
    harness.exporter.flush();
    const batches = Math.ceil(total / BOUNDS.batchRecordsMax);
    await dispositions(harness, batches);

    expect(collector.requests).toHaveLength(batches);
    const points = collector.requests.flatMap((request) => pointsOf(wireOf(request.body), 'gen_ai.client.token.usage'));
    const sets = new Set(points.map((point) => JSON.stringify(point.attributes)));
    expect(sets.size).toBe(BOUNDS.attributeSetsMax);
    const overflow = points.filter((point) => point.attributes.some((attribute) => attribute.key === 'otel.metric.overflow'));
    expect(overflow.map((point) => [point.attributes, point.count])).toEqual([
      [[{ key: 'otel.metric.overflow', value: { boolValue: true } }], '2']
    ]);
    expect(points.reduce((sum, point) => sum + Number(point.count), 0)).toBe(total);
    expect(harness.exporter.health().coverage).toMatchObject({ exported: BOUNDS.attributeSetsMax - 1, overflow: 2 });
  });

  it('refuses a profile that asks for content', () => {
    const evaluation = evaluateProfiles([profile('https://collector.example.test/v1/metrics', { contentPolicy: 'content' })], TRUSTED);
    expect(evaluation).toEqual({ kind: 'refused', reason: 'content-export-unsupported' });
  });
});

describe('F14-AC-05 slow or broken destination', () => {
  it('ends a destination that keeps failing in a counted expiry after six attempts', { timeout: WAIT_MS }, async () => {
    const attempts = BOUNDS.retriesMax + 1;
    const collector = await startCollector(...Array.from({ length: attempts }, (): CollectorScenario => ({ kind: 'status', statusCode: 503 })));
    const harness = startExporter();
    authorize(harness, collector);
    sendOne(harness, 'always-503');
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      await receipts(harness, attempt);
      await harness.time.advance(BOUNDS.retryBaseDelayMs * 2 ** (attempt - 1));
    }
    await dispositions(harness, 1);

    expect(collector.requests).toHaveLength(attempts);
    expect(new Set(collector.requests.map((request) => request.body.toString('utf8'))).size).toBe(1);
    expect(harness.ledger.receipts().map((receipt) => [receipt.outcome, receipt.statusCode, receipt.errorClass])).toEqual(
      Array.from({ length: attempts }, () => ['retry', 503, 'http-retryable'])
    );
    expect(nth(harness.ledger.dispositions(), 0)).toMatchObject({ state: 'expired', reason: 'retry-budget-exhausted' });
    const health = harness.exporter.health();
    expect(health).toMatchObject({ state: 'degraded', expiredBatches: 1, queuedBatches: 0, lastError: 'http-retryable' });
    expect(health.expiryReasons['retry-budget-exhausted']).toBe(1);
    expect(harness.time.pendingTimers()).toBe(0);
  });

  it('drops and counts a rejection and a redirect, and never follows the redirect', { timeout: WAIT_MS }, async () => {
    const elsewhere = await startCollector();
    const collector = await startCollector({ kind: 'status', statusCode: 404 }, { kind: 'redirect', location: elsewhere.url }, { kind: 'ok' });
    const harness = startExporter();
    authorize(harness, collector);
    sendOne(harness, 'rejected-1');
    await dispositions(harness, 1);
    sendOne(harness, 'redirected-1');
    await dispositions(harness, 2);
    sendOne(harness, 'accepted-1');
    await dispositions(harness, 3);

    expect(harness.ledger.dispositions().map((entry) => [entry.state, entry.reason])).toEqual([
      ['dropped', 'rejected'],
      ['dropped', 'redirect-refused'],
      ['acknowledged', null]
    ]);
    expect(harness.ledger.receipts().map((receipt) => [receipt.outcome, receipt.statusCode])).toEqual([
      ['rejected', 404],
      ['redirect-refused', 307],
      ['acknowledged', 200]
    ]);
    expect(collector.requests).toHaveLength(3);
    expect(elsewhere.connections()).toBe(0);
    const health = harness.exporter.health();
    expect(health).toMatchObject({ droppedBatches: 2, acknowledgedBatches: 1, state: 'healthy' });
    expect([health.dropReasons.rejected, health.dropReasons['redirect-refused']]).toEqual([1, 1]);
  });

  it('gives up on a silent destination at the request deadline and retries', { timeout: WAIT_MS }, async () => {
    const collector = await startCollector({ kind: 'never-answers' }, { kind: 'ok' });
    const harness = startExporter();
    authorize(harness, collector);
    const started = performance.now();
    sendOne(harness, 'silent-1');
    await receipts(harness, 1);
    const waited = performance.now() - started;
    const first = nth(harness.ledger.receipts(), 0);
    expect([first.outcome, first.errorClass, first.statusCode]).toEqual(['retry', 'deadline', null]);
    // A timer may fire a moment early by the clock it is compared with; it never fires far early.
    expect(waited).toBeGreaterThanOrEqual(BOUNDS.requestDeadlineMs - 50);
    expect(harness.exporter.health()).toMatchObject({ state: 'retrying', lastError: 'deadline', queuedBatches: 1 });

    await harness.time.advance(BOUNDS.retryBaseDelayMs);
    await receipts(harness, 2);
    expect(nth(harness.ledger.receipts(), 1).outcome).toBe('acknowledged');
    expect(nth(collector.requests, 0).body.equals(nth(collector.requests, 1).body)).toBe(true);
    expect(harness.exporter.health()).toMatchObject({ state: 'healthy', acknowledgedBatches: 1, queuedBatches: 0 });
  });

  it('keeps the memory queue inside its bound while a request hangs, and counts what it drops', { timeout: WAIT_MS }, async () => {
    const collector = await startCollector({ kind: 'never-answers' });
    const harness = startExporter();
    authorize(harness, collector);
    expect(harness.exporter.offer(heavyRecords(0)).accepted).toBe(BOUNDS.batchRecordsMax);
    await waitForCondition(() => collector.requests.length === 1, { timeoutMs: WAIT_MS, label: 'the first request to arrive' });
    const batchBytes = nth(collector.requests, 0).body.byteLength;
    expect(batchBytes).toBeGreaterThan(256 * 1_024);
    expect(batchBytes).toBeLessThanOrEqual(BOUNDS.batchBytesMax);

    const rounds = Math.ceil(BOUNDS.memoryQueueBytes / batchBytes) + 3;
    let mostQueuedBytes = 0;
    for (let round = 1; round <= rounds; round += 1) {
      expect(harness.exporter.offer(heavyRecords(round)).accepted).toBe(BOUNDS.batchRecordsMax);
      mostQueuedBytes = Math.max(mostQueuedBytes, harness.exporter.health().queuedBytes);
    }
    expect(mostQueuedBytes).toBeLessThanOrEqual(BOUNDS.memoryQueueBytes);
    expect(mostQueuedBytes).toBeGreaterThan(BOUNDS.memoryQueueBytes - batchBytes * 2);
    const health = harness.exporter.health();
    expect(health.dropReasons['queue-saturated']).toBeGreaterThanOrEqual(3);
    expect(health.droppedBatches).toBe(health.dropReasons['queue-saturated']);
    expect(collector.requests).toHaveLength(1);
  });
});

describe('F14-AC-06 disable and shutdown', () => {
  it('ends shutdown inside its budget with a request in flight and leaves no batch without a disposition', { timeout: WAIT_MS }, async () => {
    const collector = await startCollector({ kind: 'never-answers' });
    const harness = startExporter();
    authorize(harness, collector);
    sendOne(harness, 'in-flight-1');
    await waitForCondition(() => collector.requests.length === 1, { timeoutMs: WAIT_MS, label: 'the request to be in flight' });
    sendOne(harness, 'queued-1');
    expect(harness.exporter.health().queuedBatches).toBe(2);

    const started = performance.now();
    await harness.exporter.shutdown();
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(BOUNDS.shutdownBudgetMs);

    expect(harness.ledger.dispositions().map((entry) => [entry.state, entry.reason])).toEqual([
      ['dropped', 'shutdown'],
      ['dropped', 'shutdown']
    ]);
    expect(harness.ledger.receipts()).toEqual([]);
    expect(harness.exporter.offer([usageRecord({ sourceId: 'after-shutdown-1' })])).toEqual({ ...NONE, refused: 1 });
    harness.exporter.flush();
    await settle();
    expect(harness.exporter.health()).toMatchObject({ queuedBatches: 0, queuedBytes: 0, droppedBatches: 2, refusedOffers: 1 });
    expect(harness.time.pendingTimers()).toBe(0);
    expect(collector.requests).toHaveLength(1);
    expect(collector.connections()).toBe(1);
  });

  it('cancels delivery on disable, and a later destination gets none of the dropped data', { timeout: WAIT_MS }, async () => {
    const collector = await startCollector({ kind: 'never-answers' });
    const later = await startCollector();
    const harness = startExporter();
    authorize(harness, collector);
    expect(harness.exporter.offer([usageRecord({ sourceId: 'dropped-1', modelRequested: 'model-dropped-in-flight' })]).accepted).toBe(1);
    harness.exporter.flush();
    await waitForCondition(() => collector.requests.length === 1, { timeoutMs: WAIT_MS, label: 'the request to be in flight' });
    expect(harness.exporter.offer([usageRecord({ sourceId: 'dropped-2', modelRequested: 'model-dropped-queued' })]).accepted).toBe(1);
    harness.exporter.flush();
    expect(harness.exporter.offer([usageRecord({ sourceId: 'dropped-3', modelRequested: 'model-dropped-open' })]).accepted).toBe(1);

    harness.exporter.disable();
    expect(harness.exporter.health()).toMatchObject({ state: 'disabled', queuedBatches: 0, queuedBytes: 0, droppedBatches: 3 });
    expect(harness.exporter.health().dropReasons.disabled).toBe(3);
    // The batch in flight, the queued batch and the open batch each get a disposition of their own.
    expect(harness.ledger.dispositions().map((entry) => [entry.state, entry.reason])).toEqual([
      ['dropped', 'disabled'],
      ['dropped', 'disabled'],
      ['dropped', 'disabled']
    ]);
    expect(new Set(harness.ledger.dispositions().map((entry) => entry.batchId)).size).toBe(3);
    expect(harness.ledger.receipts()).toEqual([]);

    authorize(harness, later, 2);
    sendOne(harness, 'kept-1');
    await receipts(harness, 1);
    expect(later.requests).toHaveLength(1);
    const received = everythingReceived(later);
    expect(received).toContain('model-large');
    expect(received.includes('model-dropped')).toBe(false);
    expect(collector.requests).toHaveLength(1);
    expect(harness.secrets.reads()).toBe(2);
  });
});

describe('F14-AC-07 host and headless parity', () => {
  it('reaches no editor module from the exporter or its contract', () => {
    const closure = importClosure([EXPORTER_ENTRY, CONTRACT]);
    const files = [...closure.keys()];
    // The walk left the entry file: it holds every exporter module, the contract and the one usage-accounting rule.
    for (const { name } of exporterSources()) expect(files).toContain(resolve(EXPORTER_DIR, name));
    expect(files).toContain(CONTRACT);
    expect(files).toContain(resolve(SOURCE_ROOT, 'services', 'usage-accounting', 'dimension-sanitizer.ts'));
    const withEditorImport = files.filter((file) => EDITOR_IMPORT.test(closure.get(file) ?? ''));
    expect(withEditorImport).toEqual([]);
    // The control: the same needle matches the editor entry point.
    expect(EDITOR_IMPORT.test(readFileSync(EDITOR_ENTRY, 'utf8'))).toBe(true);
  });

  it('imports only Node built-ins from outside the source tree', () => {
    const closure = importClosure([EXPORTER_ENTRY, CONTRACT]);
    const outside = new Set<string>();
    for (const text of closure.values()) {
      for (const match of text.matchAll(OUTSIDE_IMPORT)) outside.add(match.at(1) ?? '');
      expect(text.includes('require(')).toBe(false);
      expect(text.includes('import(')).toBe(false);
    }
    expect([...outside].filter((specifier) => !specifier.startsWith('node:'))).toEqual([]);
    expect([...outside]).toContain('node:https');
  });
});

describe('F14-AC-08 export-only scope', () => {
  it('creates no server and no listener, and writes no file', () => {
    const sources = exporterSources();
    expect(sources.length).toBeGreaterThanOrEqual(15);
    for (const needle of SERVER_NEEDLES) {
      expect(sources.filter((source) => source.text.includes(needle)).map((source) => source.name), needle).toEqual([]);
    }
    expect(sources.filter((source) => source.text.includes('node:fs')).map((source) => source.name)).toEqual([]);
    // The control: the needles match the test collector, which is a server.
    const collectorSource = readFileSync(COLLECTOR_SOURCE, 'utf8');
    for (const needle of SERVER_NEEDLES) expect(collectorSource.includes(needle), needle).toBe(true);
  });
});

describe('F14-AC-09 no alternate authority', () => {
  it('lets a response change delivery fields only, and leaves the environment alone', { timeout: WAIT_MS }, async () => {
    const environmentBefore = digestOfEnvironment();
    const collector = await startCollector({ kind: 'partial-success', rejectedDataPoints: 3 });
    const harness = startExporter();
    authorize(harness, collector);
    sendOne(harness, 'partial-1');
    const coverageBefore = { ...harness.exporter.health().coverage };
    await receipts(harness, 1);

    const receipt = nth(harness.ledger.receipts(), 0);
    expect(Object.keys(receipt).sort()).toEqual(['at', 'attemptId', 'batchId', 'errorClass', 'outcome', 'rejectedDataPoints', 'statusCode']);
    expect(receipt).toMatchObject({ outcome: 'acknowledged', statusCode: 200, rejectedDataPoints: 3, errorClass: null });
    const health = harness.exporter.health();
    expect(health).toMatchObject({ state: 'healthy', acknowledgedBatches: 1, rejectedDataPoints: 3, lastError: null });
    expect(health.coverage).toEqual(coverageBefore);
    // The collector's answer carried an error message; none of its text is kept.
    const kept = JSON.stringify({ health, receipts: harness.ledger.receipts(), dispositions: harness.ledger.dispositions() });
    expect(kept.includes('synthetic')).toBe(false);
    expect(digestOfEnvironment()).toBe(environmentBefore);
  });

  it('reads no environment variable and names no exporter variable', () => {
    const sources = exporterSources();
    expect(sources.filter((source) => source.text.includes('process.env')).map((source) => source.name)).toEqual([]);
    expect(sources.filter((source) => source.text.includes('OTEL_')).map((source) => source.name)).toEqual([]);
    // The control: the first needle matches the module that builds a child environment.
    expect(readFileSync(ENVIRONMENT_READER, 'utf8').includes('process.env')).toBe(true);
  });
});

describe('F14-AC-10 durable delivery metadata', () => {
  it('writes one receipt and one disposition for an acknowledgement, and no other ledger fact', { timeout: WAIT_MS }, async () => {
    const calls: string[] = [];
    const inner = createInMemoryLedger();
    const ledger: TelemetryLedgerPort = {
      rememberCopy(copyId) {
        calls.push('rememberCopy');
        return inner.rememberCopy(copyId);
      },
      recordReceipt(receipt) {
        calls.push('recordReceipt');
        inner.recordReceipt(receipt);
      },
      recordDisposition(batchId, state, reason) {
        calls.push('recordDisposition');
        inner.recordDisposition(batchId, state, reason);
      }
    };
    const collector = await startCollector();
    const harness = startExporter({ ledger });
    authorize(harness, collector);
    const records = [usageRecord({ sourceId: 'ledger-1' }), usageRecord({ sourceId: 'ledger-2' }), usageRecord({ sourceId: 'ledger-3' })];
    expect(harness.exporter.offer(records)).toEqual({ ...NONE, accepted: 3 });
    expect(calls).toEqual(['rememberCopy', 'rememberCopy', 'rememberCopy']);
    expect(inner.copyCount()).toBe(3);
    harness.exporter.flush();
    await waitForCondition(() => inner.dispositions().length === 1, { timeoutMs: WAIT_MS, label: 'the acknowledgement' });

    expect(calls.slice(3)).toEqual(['recordReceipt', 'recordDisposition']);
    expect(inner.copyCount()).toBe(3);
    const receipt = nth(inner.receipts(), 0);
    expect(receipt).toMatchObject({ outcome: 'acknowledged', statusCode: 200, rejectedDataPoints: 0 });
    expect(inner.dispositions()).toEqual([{ batchId: receipt.batchId, state: 'acknowledged', reason: null }]);
    expect(collector.requests).toHaveLength(1);
  });
});
