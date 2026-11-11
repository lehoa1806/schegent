// FR-R6-F14 T014 — the exporter's offer, seal and send path: off until an authorized
// destination is configured, one request per batch with the credential header, the 256-record
// seal, one copy per source identity and revision, and the receipt of an acknowledgement
// (FR-001, FR-005, FR-011, FR-016; NFR-002).
// T022 — retries, expiry, saturation and faults of the ports (FR-010, FR-012; NFR-001).
// T024 — a retry sends the same bytes; a response changes only the receipt (FR-005, FR-013).
// T026 — disable, a new authorization generation and shutdown (FR-016; NFR-004).
import { describe, expect, it } from 'vitest';

import {
  TELEMETRY_EXPORT_BOUNDS,
  type ProfileEvaluation,
  type TelemetryLedgerPort,
  type TelemetryTransport,
  type TransportResult
} from '../../../src/contracts/telemetry-export';
import { createInMemoryLedger } from '../../../src/services/telemetry-export/in-memory-ledger';
import {
  HARNESS_START_MS,
  SYNTHETIC_CREDENTIAL,
  SYNTHETIC_ENDPOINT,
  SYNTHETIC_HEADER,
  createHarness,
  failure,
  ok,
  settle,
  status,
  type Harness
} from '../../fixtures/telemetry-export/exporter-harness';
import { cost, measure, operationRecord, usageRecord, usageRecords } from '../../fixtures/telemetry-export/source-records';

const BOUNDS = TELEMETRY_EXPORT_BOUNDS;
const DAY_MS = 24 * 60 * 60 * 1_000;

/** Offers one new record and seals it into a batch of its own. */
function sealOne(harness: Harness, sourceId: string): void {
  harness.exporter.offer([usageRecord({ sourceId })]);
  harness.exporter.flush();
}

/** 256 records with five measures and a model of their own each: a batch of several hundred KiB. */
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

interface LedgerCall {
  readonly method: keyof TelemetryLedgerPort;
  readonly args: readonly unknown[];
}

function spyLedger(): { calls: LedgerCall[]; ledger: TelemetryLedgerPort } {
  const calls: LedgerCall[] = [];
  const inner = createInMemoryLedger();
  return {
    calls,
    ledger: {
      rememberCopy(copyId) {
        calls.push({ method: 'rememberCopy', args: [copyId] });
        return inner.rememberCopy(copyId);
      },
      recordReceipt(receipt) {
        calls.push({ method: 'recordReceipt', args: [receipt] });
      },
      recordDisposition(batchId, state, reason) {
        calls.push({ method: 'recordDisposition', args: [batchId, state, reason] });
      }
    }
  };
}

function fault(): never {
  throw new Error('synthetic ledger fault');
}

/** Hands the exporter a value the transport's type does not allow. */
function unchecked(value: unknown): TransportResult {
  return value as TransportResult;
}

const EMPTY_BODY = new Uint8Array();
const MALFORMED_RESULTS: readonly (readonly [string, unknown])[] = [
  ['nothing', undefined],
  ['null', null],
  ['text', 'acknowledged'],
  ['a list', [{ kind: 'failure', errorClass: 'network' }]],
  ['an object of no kind', {}],
  ['a response without a status', { kind: 'response' }],
  ['a fractional status', { kind: 'response', statusCode: 200.5, retryAfterSeconds: null, body: EMPTY_BODY, bodyTruncated: false }],
  ['a status that is text', { kind: 'response', statusCode: '200', retryAfterSeconds: null, body: EMPTY_BODY, bodyTruncated: false }],
  ['a body that is text', { kind: 'response', statusCode: 200, retryAfterSeconds: null, body: '{}', bodyTruncated: false }],
  ['a wait that is text', { kind: 'response', statusCode: 503, retryAfterSeconds: 'soon', body: EMPTY_BODY, bodyTruncated: false }],
  ['a negative wait', { kind: 'response', statusCode: 503, retryAfterSeconds: -1, body: EMPTY_BODY, bodyTruncated: false }],
  ['a truncation mark that is text', { kind: 'response', statusCode: 200, retryAfterSeconds: null, body: EMPTY_BODY, bodyTruncated: 'no' }],
  ['a negative status', { kind: 'response', statusCode: -1, retryAfterSeconds: null, body: EMPTY_BODY, bodyTruncated: false }],
  ['an endless wait', { kind: 'response', statusCode: 503, retryAfterSeconds: Number.POSITIVE_INFINITY, body: EMPTY_BODY, bodyTruncated: false }],
  ['a wait that is no number', { kind: 'response', statusCode: 503, retryAfterSeconds: Number.NaN, body: EMPTY_BODY, bodyTruncated: false }],
  ['a wait that is absent', { kind: 'response', statusCode: 503, body: EMPTY_BODY, bodyTruncated: false }],
  ['a result of another kind', { kind: 'redirect', statusCode: 200, retryAfterSeconds: null, body: EMPTY_BODY, bodyTruncated: false }],
  ['a failure of an unknown class', { kind: 'failure', errorClass: 'remote text' }],
  ['a failure without a class', { kind: 'failure' }],
  [
    'a kind that cannot be read',
    Object.defineProperty({}, 'kind', {
      get: () => {
        throw new Error('synthetic getter fault');
      }
    })
  ]
];

const NOT_AUTHORIZED: readonly (readonly [string, ProfileEvaluation | null])[] = [
  ['no evaluation', null],
  ['a disabled evaluation', { kind: 'disabled' }],
  ['a refused evaluation', { kind: 'refused', reason: 'secret-store-unavailable' }]
];

describe('telemetry exporter: off by default', () => {
  it.each(NOT_AUTHORIZED)('queues nothing and sends nothing with %s', async (_label, evaluation) => {
    const harness = createHarness();
    if (evaluation !== null) harness.exporter.configure(evaluation, 1);
    expect(harness.exporter.offer(usageRecords(3))).toEqual({ accepted: 0, duplicate: 0, refused: 3 });
    harness.exporter.flush();
    await harness.time.advance(60_000);
    expect(harness.transport.requests).toHaveLength(0);
    expect(harness.secrets.reads()).toBe(0);
    expect(harness.time.pendingTimers()).toBe(0);
    expect(harness.ledger.copyCount()).toBe(0);
    expect(harness.exporter.health()).toMatchObject({ state: 'disabled', refusedOffers: 1, queuedBatches: 0, queuedBytes: 0 });
  });

  it('counts a list it cannot read as one refused offer and does not throw', () => {
    const harness = createHarness();
    harness.authorize();
    const unreadable = 'not a list' as unknown as readonly unknown[];
    expect(harness.exporter.offer(unreadable)).toEqual({ accepted: 0, duplicate: 0, refused: 0 });
    expect(harness.exporter.health().refusedOffers).toBe(1);
  });
});

describe('telemetry exporter: offer, seal and send', () => {
  it('sends one request with the content type and the credential header after a flush', async () => {
    const harness = createHarness();
    harness.authorize();
    expect(harness.exporter.offer([usageRecord(), operationRecord()])).toEqual({ accepted: 2, duplicate: 0, refused: 0 });
    expect(harness.transport.requests).toHaveLength(0);
    harness.exporter.flush();
    await harness.exporter.idle();
    expect(harness.transport.requests).toHaveLength(1);
    const request = harness.transport.requests.at(0);
    expect(request).toMatchObject({
      url: SYNTHETIC_ENDPOINT,
      plaintextLoopback: false,
      deadlineMs: TELEMETRY_EXPORT_BOUNDS.requestDeadlineMs,
      headers: { 'content-type': 'application/json', [SYNTHETIC_HEADER]: SYNTHETIC_CREDENTIAL }
    });
    const text = request === undefined ? '' : request.text;
    expect(text).toContain('"gen_ai.client.token.usage"');
    expect(text).toContain('"gen_ai.client.operation.duration"');
    expect(Object.keys(JSON.parse(text) as object)).toEqual(['resourceMetrics']);
    expect(harness.secrets.reads()).toBe(1);
  });

  it('sends no credential header for a destination without a credential and reads no secret', async () => {
    const harness = createHarness();
    harness.authorize({ credential: null });
    harness.exporter.offer([usageRecord()]);
    harness.exporter.flush();
    await harness.exporter.idle();
    expect(harness.transport.requests.map((request) => Object.keys(request.headers))).toEqual([['content-type']]);
    expect(harness.secrets.reads()).toBe(0);
  });

  it('sends nothing for a flush with no record', async () => {
    const harness = createHarness();
    harness.authorize();
    harness.exporter.flush();
    await harness.time.advance(1_000);
    expect(harness.transport.requests).toHaveLength(0);
    expect(harness.exporter.health()).toMatchObject({ state: 'healthy', queuedBatches: 0 });
  });

  it('seals by itself at 256 records and keeps the next record for the next batch', async () => {
    const harness = createHarness();
    harness.authorize();
    const max = TELEMETRY_EXPORT_BOUNDS.batchRecordsMax;
    expect(harness.exporter.offer(usageRecords(max - 1))).toEqual({ accepted: max - 1, duplicate: 0, refused: 0 });
    await settle();
    expect(harness.transport.requests).toHaveLength(0);
    expect(harness.exporter.offer(usageRecords(2, 'later'))).toEqual({ accepted: 2, duplicate: 0, refused: 0 });
    await harness.exporter.idle();
    expect(harness.transport.requests).toHaveLength(1);
    harness.exporter.flush();
    await harness.exporter.idle();
    expect(harness.transport.requests).toHaveLength(2);
    expect(harness.exporter.health()).toMatchObject({ acknowledgedBatches: 2, queuedBatches: 0 });
  });

  it('seals before a record that would take the batch past 1 MiB', async () => {
    // Twelve token data points and a model of its own per record: 256 of them do not fit one batch.
    const provenances = ['provider-reported', 'derived', 'estimated'] as const;
    const widest = Array.from({ length: BOUNDS.batchRecordsMax }, (_unused, index) =>
      usageRecord({
        sourceId: `widest-${String(index)}`,
        modelRequested: `model-${String(index)}-${'r'.repeat(96)}`,
        modelReported: `model-${String(index)}-${'s'.repeat(96)}`,
        measures: (['input_tokens', 'output_tokens'] as const).flatMap((name) =>
          provenances.flatMap((provenance) => [
            measure({ measure: name, provenance }),
            measure({ measure: name, provenance, completeness: 'partial' })
          ])
        )
      })
    );
    const harness = createHarness();
    harness.authorize();
    expect(harness.exporter.offer(widest).accepted).toBe(BOUNDS.batchRecordsMax);
    harness.exporter.flush();
    await harness.exporter.idle();
    const sizes = harness.transport.requests.map((request) => request.body.byteLength);
    // The record bound alone would have made one batch of the 256 records.
    expect(sizes.length).toBeGreaterThan(1);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(BOUNDS.batchBytesMax);
    expect(Math.max(...sizes)).toBeGreaterThan(256 * 1_024);
    expect(harness.exporter.health().acknowledgedBatches).toBe(sizes.length);
  });

  it('makes one copy of a source identity and revision offered twice', async () => {
    const harness = createHarness();
    harness.authorize();
    const record = usageRecord();
    expect(harness.exporter.offer([record, record])).toEqual({ accepted: 1, duplicate: 1, refused: 0 });
    harness.exporter.flush();
    await harness.exporter.idle();
    expect(harness.exporter.offer([usageRecord()])).toEqual({ accepted: 0, duplicate: 1, refused: 0 });
    harness.exporter.flush();
    await harness.exporter.idle();
    expect(harness.transport.requests).toHaveLength(1);
    expect(harness.ledger.copyCount()).toBe(1);
    expect(harness.exporter.health()).toMatchObject({ duplicateRecords: 2, acknowledgedBatches: 1 });
  });

  it('takes a new revision of the same source identity as a new copy', () => {
    const harness = createHarness();
    harness.authorize();
    const counts = harness.exporter.offer([usageRecord(), usageRecord({ sourceRevision: 1 })]);
    expect(counts).toEqual({ accepted: 2, duplicate: 0, refused: 0 });
  });

  it('counts a record of another schema and a malformed record without stopping the rest', () => {
    const harness = createHarness();
    harness.authorize();
    const throwing = Object.defineProperty({}, 'sourceSchema', {
      enumerable: true,
      get() {
        throw new Error('synthetic getter fault');
      }
    });
    const offered = [{ ...usageRecord(), sourceSchema: 2 }, { kind: 'usage' }, null, throwing, usageRecord()];
    expect(harness.exporter.offer(offered)).toEqual({ accepted: 1, duplicate: 0, refused: 4 });
    expect(harness.exporter.health()).toMatchObject({ unsupportedSchemaRecords: 1, invalidRecords: 3, refusedOffers: 0 });
  });

  it('records a receipt and the time of an acknowledgement', async () => {
    const harness = createHarness();
    harness.authorize();
    expect(harness.exporter.health().lastSuccessAt).toBeNull();
    harness.exporter.offer([usageRecord()]);
    harness.time.jump(5_000);
    harness.exporter.flush();
    await harness.exporter.idle();
    const receipts = harness.ledger.receipts();
    expect(receipts).toHaveLength(1);
    expect(receipts.at(0)).toMatchObject({
      at: HARNESS_START_MS + 5_000,
      outcome: 'acknowledged',
      statusCode: 200,
      rejectedDataPoints: 0,
      errorClass: null
    });
    const dispositions = harness.ledger.dispositions();
    expect(dispositions).toHaveLength(1);
    expect(dispositions.at(0)).toMatchObject({ state: 'acknowledged', reason: null });
    expect(dispositions.map((entry) => entry.batchId)).toEqual(receipts.map((entry) => entry.batchId));
    expect(harness.exporter.health()).toMatchObject({
      state: 'healthy',
      lastSuccessAt: HARNESS_START_MS + 5_000,
      acknowledgedBatches: 1,
      lastError: null
    });
  });
});

describe('telemetry exporter: retries and expiry', () => {
  it('makes at most six attempts inside the retry budget and then expires the batch', async () => {
    const harness = createHarness();
    harness.authorize();
    harness.transport.answer(...Array.from({ length: 10 }, () => status(503)));
    sealOne(harness, 'retry-1');
    await harness.time.advance(120_000);
    expect(harness.transport.requests).toHaveLength(BOUNDS.retriesMax + 1);
    expect(harness.time.delays()).toHaveLength(BOUNDS.retriesMax);
    expect(harness.time.delays().reduce((sum, delay) => sum + delay, 0)).toBeLessThan(BOUNDS.retryBudgetMs);
    expect(harness.time.pendingTimers()).toBe(0);
    const health = harness.exporter.health();
    expect(health).toMatchObject({ state: 'degraded', expiredBatches: 1, queuedBatches: 0, lastError: 'http-retryable' });
    expect(health.expiryReasons).toEqual({ age: 0, 'retry-budget-exhausted': 1 });
    expect(harness.ledger.dispositions().map((entry) => [entry.state, entry.reason])).toEqual([
      ['expired', 'retry-budget-exhausted']
    ]);
    expect(harness.transport.inFlightMax()).toBe(1);
  });

  it.each([
    ['a client error', status(400), 'rejected', 'http-rejected'],
    ['an authorization error', status(401), 'rejected', 'http-rejected'],
    ['a redirect', status(302), 'redirect-refused', 'redirect-refused']
  ] as const)('drops the batch without a retry on %s', async (_label, answer, reason, errorClass) => {
    const harness = createHarness();
    harness.authorize();
    harness.transport.answer(answer);
    sealOne(harness, 'drop-1');
    await harness.time.advance(120_000);
    expect(harness.transport.requests).toHaveLength(1);
    expect(harness.time.delays()).toEqual([]);
    const health = harness.exporter.health();
    expect(health).toMatchObject({ state: 'degraded', droppedBatches: 1, lastError: errorClass });
    expect(health.dropReasons[reason]).toBe(1);
    expect(harness.ledger.receipts().map((receipt) => receipt.outcome)).toEqual([reason]);
  });

  it('waits as long as the destination asks when that fits the budget', async () => {
    const harness = createHarness();
    harness.authorize();
    harness.transport.answer(status(429, 3));
    sealOne(harness, 'retry-after-1');
    await settle();
    expect(harness.time.delays()).toEqual([3_000]);
    await harness.time.advance(2_999);
    expect(harness.transport.requests).toHaveLength(1);
    await harness.time.advance(1);
    expect(harness.transport.requests).toHaveLength(2);
    expect(harness.exporter.health()).toMatchObject({ state: 'healthy', acknowledgedBatches: 1 });
  });

  it('expires the batch without waiting when the destination asks for more than the budget', async () => {
    const harness = createHarness();
    harness.authorize();
    harness.transport.answer(status(503, 60));
    sealOne(harness, 'retry-after-2');
    await settle();
    expect(harness.time.pendingTimers()).toBe(0);
    expect(harness.transport.requests).toHaveLength(1);
    expect(harness.exporter.health().expiryReasons['retry-budget-exhausted']).toBe(1);
  });

  it('expires a batch older than 24 hours without sending it', async () => {
    const harness = createHarness();
    harness.authorize();
    harness.transport.answer(status(503));
    sealOne(harness, 'old-1');
    await settle();
    sealOne(harness, 'old-2');
    expect(harness.exporter.health().queuedBatches).toBe(2);
    harness.time.jump(DAY_MS + 1);
    await harness.time.advance(1_000);
    expect(harness.transport.requests).toHaveLength(1);
    const health = harness.exporter.health();
    expect(health).toMatchObject({ expiredBatches: 2, queuedBatches: 0, queuedBytes: 0 });
    expect(health.expiryReasons).toEqual({ age: 2, 'retry-budget-exhausted': 0 });
    await harness.time.advance(DAY_MS);
    expect(harness.transport.requests).toHaveLength(1);
  });

  it('retries a lost connection, a failed handshake and a missed deadline', async () => {
    const harness = createHarness();
    harness.authorize();
    harness.transport.answer(failure('network'), failure('tls'), failure('deadline'));
    sealOne(harness, 'lost-1');
    await harness.time.advance(30_000);
    expect(harness.ledger.receipts().map((receipt) => [receipt.outcome, receipt.statusCode, receipt.errorClass])).toEqual([
      ['retry', null, 'network'],
      ['retry', null, 'tls'],
      ['retry', null, 'deadline'],
      ['acknowledged', 200, null]
    ]);
  });

  it('moves from healthy to retrying to degraded and back to healthy', async () => {
    const harness = createHarness();
    harness.authorize();
    expect(harness.exporter.health().state).toBe('healthy');
    harness.transport.answer(...Array.from({ length: BOUNDS.retriesMax + 1 }, () => status(503)));
    sealOne(harness, 'health-1');
    await settle();
    expect(harness.exporter.health()).toMatchObject({ state: 'retrying', queuedBatches: 1 });
    await harness.time.advance(120_000);
    expect(harness.exporter.health().state).toBe('degraded');
    sealOne(harness, 'health-2');
    await harness.exporter.idle();
    expect(harness.exporter.health()).toMatchObject({ state: 'healthy', lastError: null });
  });
});

describe('telemetry exporter: saturation and faults', () => {
  it('drops the oldest batch that is not being sent and never passes the queue bound', async () => {
    const harness = createHarness();
    harness.authorize();
    harness.transport.answer('hang');
    harness.exporter.offer(heavyRecords(0));
    await settle();
    expect(harness.transport.requests).toHaveLength(1);
    const first = harness.transport.requests.at(0);
    const batchBytes = first === undefined ? 0 : first.body.byteLength;
    expect(batchBytes).toBeGreaterThan(256 * 1_024);
    expect(batchBytes).toBeLessThanOrEqual(BOUNDS.batchBytesMax);
    const rounds = Math.ceil(BOUNDS.memoryQueueBytes / batchBytes) + 3;
    let mostQueuedBytes = 0;
    for (let round = 1; round <= rounds; round += 1) {
      expect(harness.exporter.offer(heavyRecords(round)).accepted).toBe(BOUNDS.batchRecordsMax);
      mostQueuedBytes = Math.max(mostQueuedBytes, harness.exporter.health().queuedBytes);
    }
    await settle();
    expect(mostQueuedBytes).toBeLessThanOrEqual(BOUNDS.memoryQueueBytes);
    expect(mostQueuedBytes).toBeGreaterThan(BOUNDS.memoryQueueBytes - batchBytes * 2);
    const health = harness.exporter.health();
    expect(health.dropReasons['queue-saturated']).toBeGreaterThanOrEqual(3);
    expect(health.droppedBatches).toBe(health.dropReasons['queue-saturated']);
    expect(harness.transport.requests).toHaveLength(1);
    expect(harness.transport.inFlight()).toBe(1);
    await harness.exporter.shutdown();
  });

  it('treats a transport that throws as a lost connection', async () => {
    const harness = createHarness();
    harness.authorize();
    harness.transport.answer('throw');
    expect(() => {
      sealOne(harness, 'throw-1');
    }).not.toThrow();
    await harness.time.advance(1_000);
    expect(harness.ledger.receipts().map((receipt) => [receipt.outcome, receipt.errorClass])).toEqual([
      ['retry', 'network'],
      ['acknowledged', null]
    ]);
  });

  it.each(MALFORMED_RESULTS)('treats a transport that resolves %s as a lost connection', async (_label, malformed) => {
    // The transport is the one port that carries what a remote party sent. A result outside the
    // closed type is not classified: nothing of it reaches a receipt or the health view.
    const answers: unknown[] = [malformed];
    const transport: TelemetryTransport = {
      send: () => Promise.resolve(unchecked(answers.length > 0 ? answers.shift() : ok()))
    };
    const harness = createHarness({ transport });
    harness.authorize();
    sealOne(harness, 'malformed-1');
    await settle();
    expect(harness.exporter.health().lastError).toBe('network');
    await harness.time.advance(1_000);
    expect(harness.ledger.receipts().map((receipt) => [receipt.outcome, receipt.statusCode, receipt.errorClass])).toEqual([
      ['retry', null, 'network'],
      ['acknowledged', 200, null]
    ]);
    await harness.exporter.idle();
    expect(harness.exporter.health().state).toBe('healthy');
  });

  it.each([
    ['throws', 'throw', 'credential-unavailable'],
    ['has no value', null, 'credential-unavailable'],
    ['holds an empty value', '', 'credential-invalid'],
    ['holds a value with a line break', 'first\r\nx-injected: 1', 'credential-invalid'],
    ['holds a value with a control character', 'value\twith-tab', 'credential-invalid']
  ] as const)('drops the batch unsent when the secret port %s', async (_label, held, reason) => {
    const harness = createHarness();
    harness.authorize();
    harness.secrets.set(held);
    sealOne(harness, 'secret-1');
    sealOne(harness, 'secret-2');
    await harness.exporter.idle();
    expect(harness.transport.requests).toHaveLength(0);
    expect(harness.secrets.reads()).toBe(1);
    const health = harness.exporter.health();
    expect(health).toMatchObject({ state: 'degraded', droppedBatches: 2, lastError: reason });
    expect(health.dropReasons[reason]).toBe(2);
    expect(harness.ledger.receipts()).toEqual([]);
  });

  it('drops the batch unsent when the secret store is not available or absent', async () => {
    const unavailable = createHarness();
    unavailable.authorize();
    unavailable.secrets.setAvailability('unavailable');
    sealOne(unavailable, 'secret-3');
    await unavailable.exporter.idle();
    expect(unavailable.secrets.reads()).toBe(0);
    expect(unavailable.exporter.health().dropReasons['credential-unavailable']).toBe(1);

    const absent = createHarness({ secrets: null });
    absent.authorize();
    sealOne(absent, 'secret-4');
    await absent.exporter.idle();
    expect(absent.transport.requests).toHaveLength(0);
    expect(absent.exporter.health().dropReasons['credential-unavailable']).toBe(1);
  });

  it('refuses a record it cannot remember and counts the ledger fault', () => {
    const harness = createHarness({ ledger: { rememberCopy: fault, recordReceipt: fault, recordDisposition: fault } });
    harness.authorize();
    expect(harness.exporter.offer(usageRecords(2))).toEqual({ accepted: 0, duplicate: 0, refused: 2 });
    expect(harness.exporter.health()).toMatchObject({ ledgerFaults: 2, queuedBatches: 0 });
  });

  it('still delivers when the ledger cannot record a receipt or a disposition', async () => {
    const copies = createInMemoryLedger();
    const ledger: TelemetryLedgerPort = {
      rememberCopy: (copyId) => copies.rememberCopy(copyId),
      recordReceipt: fault,
      recordDisposition: fault
    };
    const harness = createHarness({ ledger });
    harness.authorize();
    sealOne(harness, 'ledger-1');
    await harness.exporter.idle();
    expect(harness.transport.requests).toHaveLength(1);
    expect(harness.exporter.health()).toMatchObject({ state: 'healthy', acknowledgedBatches: 1, ledgerFaults: 2 });
  });
});

describe('telemetry exporter: one copy, one batch identity', () => {
  it('sends byte-identical bodies under one batch identity when an acknowledgement is lost', async () => {
    const harness = createHarness();
    harness.authorize();
    harness.transport.answer(failure('network'));
    harness.exporter.offer([usageRecord(), operationRecord()]);
    harness.exporter.flush();
    await harness.time.advance(1_000);
    expect(harness.transport.requests).toHaveLength(2);
    const bodies = harness.transport.requests.map((request) => request.text);
    expect(bodies.at(1)).toBe(bodies.at(0));
    const receipts = harness.ledger.receipts();
    expect(new Set(receipts.map((receipt) => receipt.batchId)).size).toBe(1);
    expect(new Set(receipts.map((receipt) => receipt.attemptId)).size).toBe(2);
    expect(harness.ledger.copyCount()).toBe(2);
    expect(harness.exporter.health()).toMatchObject({ acknowledgedBatches: 1, duplicateRecords: 0 });
  });

  it('lets a response change only the receipt and the rejected count', async () => {
    const harness = createHarness();
    harness.authorize();
    const reply = JSON.stringify({
      partialSuccess: { rejectedDataPoints: '3', errorMessage: 'synthetic-remote-text' },
      resourceMetrics: [{ scopeMetrics: [{ metrics: [{ name: 'gen_ai.client.token.usage' }] }] }],
      records: [usageRecord({ sourceId: 'from-the-response' })]
    });
    harness.transport.answer(ok(reply));
    sealOne(harness, 'reply-1');
    await harness.exporter.idle();
    await harness.time.advance(60_000);
    expect(harness.transport.requests).toHaveLength(1);
    expect(harness.ledger.copyCount()).toBe(1);
    const health = harness.exporter.health();
    expect(health).toMatchObject({ rejectedDataPoints: 3, acknowledgedBatches: 1, queuedBatches: 0, lastError: null });
    const kept = JSON.stringify([health, harness.ledger.receipts(), harness.ledger.dispositions()]);
    expect(kept).not.toContain('synthetic-remote-text');
    expect(kept).not.toContain('from-the-response');
    expect(harness.ledger.receipts().at(0)).toMatchObject({ outcome: 'acknowledged', rejectedDataPoints: 3 });
  });

  it('gives the ledger only copy identities, receipts and dispositions', async () => {
    const spy = spyLedger();
    const harness = createHarness({ ledger: spy.ledger });
    harness.authorize();
    harness.transport.answer(status(503));
    harness.exporter.offer([usageRecord({ sourceId: 'source-marker-1' }), operationRecord({ sourceId: 'source-marker-2' })]);
    harness.exporter.flush();
    await harness.time.advance(1_000);
    expect(spy.calls.map((call) => call.method)).toEqual([
      'rememberCopy',
      'rememberCopy',
      'recordReceipt',
      'recordReceipt',
      'recordDisposition'
    ]);
    const copies = spy.calls.filter((call) => call.method === 'rememberCopy').map((call) => call.args.at(0));
    expect(copies.every((copy) => typeof copy === 'string' && /^[0-9a-f]{64}$/.test(copy))).toBe(true);
    const receiptKeys = spy.calls.filter((call) => call.method === 'recordReceipt').map((call) => Object.keys(call.args.at(0) ?? {}));
    const expectedKeys = ['batchId', 'attemptId', 'at', 'outcome', 'statusCode', 'rejectedDataPoints', 'errorClass'];
    expect(receiptKeys).toEqual([expectedKeys, expectedKeys]);
    const text = JSON.stringify(spy.calls);
    expect(text).not.toContain('source-marker');
    expect(text).not.toContain('model-large');
    expect(text).not.toContain(SYNTHETIC_CREDENTIAL);
  });
});

describe('telemetry exporter: disable, authorization change and shutdown', () => {
  it('aborts the request in flight and drops what is queued on disable', async () => {
    const harness = createHarness();
    harness.authorize();
    harness.transport.answer('hang');
    sealOne(harness, 'disable-1');
    await settle();
    sealOne(harness, 'disable-2');
    harness.exporter.offer([usageRecord({ sourceId: 'disable-3' })]);
    expect(harness.transport.inFlight()).toBe(1);
    harness.exporter.disable();
    await settle();
    expect(harness.transport.inFlight()).toBe(0);
    const health = harness.exporter.health();
    expect(health).toMatchObject({ state: 'disabled', queuedBatches: 0, queuedBytes: 0, droppedBatches: 3 });
    expect(health.dropReasons.disabled).toBe(3);
    expect(harness.ledger.receipts()).toEqual([]);
    await harness.time.advance(120_000);
    expect(harness.transport.requests).toHaveLength(1);
  });

  it('cancels the retry timer on disable', async () => {
    const harness = createHarness();
    harness.authorize();
    harness.transport.answer(status(503));
    sealOne(harness, 'disable-4');
    await settle();
    expect(harness.time.pendingTimers()).toBe(1);
    harness.exporter.configure({ kind: 'disabled' }, 1);
    expect(harness.time.pendingTimers()).toBe(0);
    await harness.time.advance(120_000);
    expect(harness.transport.requests).toHaveLength(1);
    expect(harness.exporter.health().dropReasons.disabled).toBe(1);
  });

  it('reads the secret again after it was disabled and configured again', async () => {
    const harness = createHarness();
    harness.authorize();
    sealOne(harness, 'again-1');
    await harness.exporter.idle();
    sealOne(harness, 'again-2');
    await harness.exporter.idle();
    expect(harness.secrets.reads()).toBe(1);
    harness.exporter.disable();
    harness.authorize();
    sealOne(harness, 'again-3');
    await harness.exporter.idle();
    expect(harness.secrets.reads()).toBe(2);
    expect(harness.transport.requests).toHaveLength(3);
  });

  it('drops the batches of an earlier authorization generation and never sends them', async () => {
    const harness = createHarness();
    harness.authorize();
    harness.transport.answer('hang');
    sealOne(harness, 'generation-1');
    await settle();
    sealOne(harness, 'generation-2');
    harness.authorize({}, 2);
    await settle();
    const health = harness.exporter.health();
    expect(health).toMatchObject({ state: 'healthy', queuedBatches: 0 });
    expect(health.dropReasons['authorization-changed']).toBe(2);
    sealOne(harness, 'generation-3');
    await harness.exporter.idle();
    expect(harness.transport.requests).toHaveLength(2);
    expect(harness.secrets.reads()).toBe(2);
    expect(harness.exporter.health().acknowledgedBatches).toBe(1);
  });

  it('treats a changed destination and a refused evaluation as an authorization change', async () => {
    const harness = createHarness();
    harness.authorize();
    harness.exporter.offer([usageRecord({ sourceId: 'change-1' })]);
    harness.authorize({ endpoint: 'https://other.example.test/v1/metrics' });
    expect(harness.exporter.health().dropReasons['authorization-changed']).toBe(1);
    harness.exporter.offer([usageRecord({ sourceId: 'change-2' })]);
    harness.exporter.configure({ kind: 'refused', reason: 'secret-store-unavailable' }, 1);
    expect(harness.exporter.health()).toMatchObject({ state: 'disabled', droppedBatches: 2 });
    expect(harness.exporter.health().dropReasons['authorization-changed']).toBe(2);
    await harness.time.advance(1_000);
    expect(harness.transport.requests).toHaveLength(0);
  });

  it('changes nothing when the same destination and generation are configured again', async () => {
    const harness = createHarness();
    harness.authorize();
    harness.exporter.offer([usageRecord({ sourceId: 'same-1' })]);
    harness.authorize();
    harness.exporter.flush();
    await harness.exporter.idle();
    expect(harness.exporter.health()).toMatchObject({ droppedBatches: 0, acknowledgedBatches: 1 });
  });

  it('starts no request while an aborted one has not ended', async () => {
    let release = (): void => undefined;
    let sent = 0;
    const transport: TelemetryTransport = {
      send() {
        sent += 1;
        if (sent > 1) return Promise.resolve(ok());
        return new Promise<TransportResult>((resolve) => {
          release = () => {
            resolve({ kind: 'failure', errorClass: 'aborted' });
          };
        });
      }
    };
    const harness = createHarness({ transport });
    harness.authorize();
    sealOne(harness, 'unwind-1');
    await settle();
    harness.authorize({}, 2);
    sealOne(harness, 'unwind-2');
    await settle();
    expect(sent).toBe(1);
    release();
    await harness.exporter.idle();
    expect(sent).toBe(2);
    expect(harness.exporter.health()).toMatchObject({ acknowledgedBatches: 1, lastError: null });
  });

  it('drops queued batches on shutdown, refuses later offers and leaves no timer', async () => {
    const harness = createHarness();
    harness.authorize();
    harness.transport.answer('hang');
    sealOne(harness, 'shutdown-1');
    await settle();
    sealOne(harness, 'shutdown-2');
    harness.exporter.offer([usageRecord({ sourceId: 'shutdown-3' })]);
    await harness.exporter.shutdown();
    expect(harness.time.pendingTimers()).toBe(0);
    expect(harness.transport.inFlight()).toBe(0);
    const health = harness.exporter.health();
    expect(health).toMatchObject({ state: 'disabled', queuedBatches: 0, droppedBatches: 3 });
    expect(health.dropReasons.shutdown).toBe(3);
    expect(harness.exporter.offer([usageRecord({ sourceId: 'shutdown-4' })])).toEqual({ accepted: 0, duplicate: 0, refused: 1 });
    harness.authorize();
    harness.exporter.flush();
    await harness.time.advance(120_000);
    expect(harness.transport.requests).toHaveLength(1);
    expect(harness.exporter.health()).toMatchObject({ state: 'disabled', refusedOffers: 1 });
    await expect(harness.exporter.shutdown()).resolves.toBeUndefined();
  });

  it('cancels the retry timer on shutdown', async () => {
    const harness = createHarness();
    harness.authorize();
    harness.transport.answer(status(503));
    sealOne(harness, 'shutdown-5');
    await settle();
    expect(harness.time.pendingTimers()).toBe(1);
    await harness.exporter.shutdown();
    expect(harness.time.pendingTimers()).toBe(0);
  });

  it('resolves shutdown inside its budget when the request never ends', async () => {
    const stuck: TelemetryTransport = { send: () => new Promise<TransportResult>(() => undefined) };
    const harness = createHarness({ transport: stuck });
    harness.authorize();
    sealOne(harness, 'stuck-1');
    await settle();
    let resolved = false;
    void harness.exporter.shutdown().then(() => {
      resolved = true;
    });
    await harness.time.advance(BOUNDS.shutdownBudgetMs - 1);
    expect(resolved).toBe(false);
    await harness.time.advance(1);
    expect(resolved).toBe(true);
    expect(harness.time.pendingTimers()).toBe(0);
  });
});
